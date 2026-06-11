/**
 * Tests for streaming resilience:
 *   1. Upstream hangs with no bytes for > IDLE_TIMEOUT_MS → non-stream fallback succeeds
 *   2. Upstream returns 504 immediately → non-stream fallback succeeds
 *   3. Upstream succeeds on the non-stream fallback after streaming fails
 *   4. Circuit breaker opens after N consecutive 504 failures
 *   5. Circuit breaker returns 503 when open
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker } from '../src/utils/circuit-breaker';
import { resetConfigCache, loadConfig } from '../src/config/env';

// ─────────────────────────────────────────────────────────────────────────────
// CircuitBreaker unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe('CircuitBreaker', () => {
  const makeBreaker = (threshold = 3, recoveryMs = 100, rollingMs = 5000) =>
    new CircuitBreaker({ failureThreshold: threshold, recoveryMs, rollingMs });

  it('starts CLOSED', () => {
    const cb = makeBreaker();
    assert.equal(cb.getState('gpt-5.5'), 'CLOSED');
    assert.equal(cb.allowRequest('gpt-5.5'), true);
  });

  it('opens after threshold failures', () => {
    const cb = makeBreaker(3);
    cb.recordFailure('m');
    cb.recordFailure('m');
    assert.equal(cb.getState('m'), 'CLOSED'); // 2 < 3 threshold
    cb.recordFailure('m');
    assert.equal(cb.getState('m'), 'OPEN');
    assert.equal(cb.allowRequest('m'), false);
  });

  it('transitions OPEN → HALF after recoveryMs, then CLOSED on success', async () => {
    const cb = makeBreaker(2, 50 /* 50ms recovery */);
    cb.recordFailure('m');
    cb.recordFailure('m');
    assert.equal(cb.getState('m'), 'OPEN');
    assert.equal(cb.allowRequest('m'), false);

    await new Promise((r) => setTimeout(r, 60));
    // After recovery window, one probe is allowed
    assert.equal(cb.allowRequest('m'), true);
    assert.equal(cb.getState('m'), 'HALF');

    cb.recordSuccess('m');
    assert.equal(cb.getState('m'), 'CLOSED');
    assert.equal(cb.allowRequest('m'), true);
  });

  it('failure in HALF re-opens the circuit', async () => {
    const cb = makeBreaker(2, 50);
    cb.recordFailure('m');
    cb.recordFailure('m');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(cb.allowRequest('m'), true); // HALF
    cb.recordFailure('m'); // probe failed
    assert.equal(cb.getState('m'), 'OPEN');
    assert.equal(cb.allowRequest('m'), false);
  });

  it('recordSuccess resets failure window', () => {
    const cb = makeBreaker(3);
    cb.recordFailure('m');
    cb.recordFailure('m');
    cb.recordSuccess('m');
    assert.equal(cb.getState('m'), 'CLOSED');
    // Two more failures should not open it immediately (window reset)
    cb.recordFailure('m');
    cb.recordFailure('m');
    assert.equal(cb.getState('m'), 'CLOSED');
  });

  it('prunes failures outside the rolling window', async () => {
    const cb = makeBreaker(3, 1000, 50 /* 50ms rolling window */);
    cb.recordFailure('m');
    cb.recordFailure('m');
    await new Promise((r) => setTimeout(r, 60)); // let them expire
    cb.recordFailure('m'); // only 1 in window — should not open
    assert.equal(cb.getState('m'), 'CLOSED');
  });

  it('snapshot reports correct counts', () => {
    const cb = makeBreaker(5);
    cb.recordFailure('x');
    cb.recordFailure('x');
    const snap = cb.snapshot('x');
    assert.equal(snap.state, 'CLOSED');
    assert.equal(snap.recentFailures, 2);
    assert.equal(snap.openedAt, null);
  });

  it('handles independent model keys separately', () => {
    const cb = makeBreaker(2);
    cb.recordFailure('a');
    cb.recordFailure('a');
    assert.equal(cb.getState('a'), 'OPEN');
    assert.equal(cb.getState('b'), 'CLOSED'); // unaffected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config env: new resilience knobs
// ─────────────────────────────────────────────────────────────────────────────
describe('config: streaming resilience env vars', () => {
  beforeEach(() => resetConfigCache());
  after(() => resetConfigCache());

  it('defaults: idleTimeoutMs=12000, keepAlivePingMs=10000', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.idleTimeoutMs, 12_000);
    assert.equal(cfg.keepAlivePingMs, 10_000);
  });

  it('reads IDLE_TIMEOUT_MS from env', () => {
    const cfg = loadConfig({ IDLE_TIMEOUT_MS: '8000' });
    assert.equal(cfg.idleTimeoutMs, 8_000);
  });

  it('reads KEEP_ALIVE_PING_MS=0 (disabled)', () => {
    const cfg = loadConfig({ KEEP_ALIVE_PING_MS: '0' });
    assert.equal(cfg.keepAlivePingMs, 0);
  });

  it('reads circuit breaker knobs', () => {
    const cfg = loadConfig({
      CIRCUIT_BREAKER_FAILURES: '5',
      CIRCUIT_BREAKER_RECOVERY_MS: '60000',
      CIRCUIT_BREAKER_ROLLING_MS: '120000',
    });
    assert.equal(cfg.circuitBreakerFailures, 5);
    assert.equal(cfg.circuitBreakerRecoveryMs, 60_000);
    assert.equal(cfg.circuitBreakerRollingMs, 120_000);
  });

  it('defaults: circuitBreakerFailures=3, recoveryMs=30000, rollingMs=60000', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.circuitBreakerFailures, 3);
    assert.equal(cfg.circuitBreakerRecoveryMs, 30_000);
    assert.equal(cfg.circuitBreakerRollingMs, 60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BluesmindsService: streaming failure → fallback scenarios
// Uses a minimal mock fetch to simulate upstream behaviour without a real server.
// ─────────────────────────────────────────────────────────────────────────────
describe('BluesmindsService: createChatCompletionStream + createChatCompletionNonStream', () => {
  // We test the service by monkey-patching global fetch inside each test.
  // Node 20+ has global fetch.

  const { BluesmindsService } = require('../src/services/bluesminds.service') as typeof import('../src/services/bluesminds.service');

  const makeService = () =>
    new BluesmindsService({ baseUrl: 'https://fake.api/v1', apiKey: 'test', timeoutMs: 5000 });

  const OPENAI_SUCCESS_STREAM = [
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n',
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
  ].join('\n');

  const OPENAI_SUCCESS_JSON: object = {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-5.5',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello fallback' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  function makeStreamResponse(body: string, status = 200): Response {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  function makeJsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('scenario A: upstream 504 immediately → createChatCompletionStream returns ok:false status:504', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => makeJsonResponse({ error: { message: 'Stream connection timed out after 15000ms', type: 'timeout_error' } }, 504);
    try {
      const svc = makeService();
      const result = await svc.createChatCompletionStream(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true },
        null,
      );
      assert.equal(result.ok, false);
      assert.equal((result as { status: number }).status, 504);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('scenario B: upstream 504 immediately, createChatCompletionNonStream succeeds', async () => {
    const original = globalThis.fetch;
    // With no backup, createChatCompletionStream retries up to MAX_RETRIES (2) times.
    // So the non-stream call (made manually after) is call #4.
    let streamCallsDone = false;
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.stream === true) {
        return makeJsonResponse({ error: { message: 'timeout' } }, 504);
      }
      // Non-stream call
      streamCallsDone = true;
      return makeJsonResponse(OPENAI_SUCCESS_JSON, 200);
    };
    try {
      const svc = makeService();
      // Stream fails (all retries exhaust)
      const streamResult = await svc.createChatCompletionStream(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true },
        null,
      );
      assert.equal(streamResult.ok, false);
      // Non-stream fallback succeeds
      const fallbackResult = await svc.createChatCompletionNonStream(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: false },
      );
      assert.equal(fallbackResult.ok, true);
      assert.equal(streamCallsDone, true);
      const body = fallbackResult.body as { choices: Array<{ message: { content: string } }> };
      assert.equal(body.choices[0].message.content, 'hello fallback');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('scenario C: upstream stream succeeds normally', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => makeStreamResponse(OPENAI_SUCCESS_STREAM, 200);
    try {
      const svc = makeService();
      const result = await svc.createChatCompletionStream(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true },
        null,
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        // Drain the stream
        const reader = result.response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
        }
        assert.ok(text.includes('hello'));
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it('scenario D: 504 triggers BACKUP_TRIGGER_STATUSES cascade to backup model', async () => {
    const original = globalThis.fetch;
    let callCount = 0;
    let lastModel = '';
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = init?.body ? JSON.parse(init.body as string) : {};
      lastModel = body.model ?? '';
      if (callCount === 1) {
        // Primary fails with 504
        return makeJsonResponse({ error: { message: 'timeout' } }, 504);
      }
      // Backup stream succeeds
      return makeStreamResponse(OPENAI_SUCCESS_STREAM, 200);
    };
    try {
      const svc = makeService();
      const result = await svc.createChatCompletionStream(
        { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], stream: true },
        'backup-model',
      );
      assert.equal(result.ok, true);
      assert.equal((result as { cascadedToBackup?: boolean }).cascadedToBackup, true);
      assert.equal(lastModel, 'backup-model');
    } finally {
      globalThis.fetch = original;
    }
  });
});
