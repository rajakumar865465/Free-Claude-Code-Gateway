import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderFailoverEngine, describeFetchError, type AltProvider } from '../src/provider-failover/engine';
import type { FailoverConfig, ProviderStatus, SwitchLogEntry } from '../src/provider-failover/types';
import type { ProviderResponse } from '../src/services/bluesminds.service';

// ── Test doubles ──────────────────────────────────────────────────────────────
// In-memory storage + provider manager so tests never touch disk or the network.

interface FakeProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  notes: string;
  createdAt: string;
}

const DEFAULT_CONFIG: FailoverConfig = {
  failover_enabled: true,
  health_check_interval: 300,
  max_retries: 3,
  // Zero delays keep retry tests instant.
  retry_delay_1: 0,
  retry_delay_2: 0,
  alert_on_switch: false,
  cooldown_seconds: 120,
  health_probe_uses_chat: true,
  first_check_delay_seconds: 7,
  startup_grace_seconds: 30,
  failure_threshold: 3,
};

class FakeStorage {
  private config: FailoverConfig = { ...DEFAULT_CONFIG };
  private statuses: ProviderStatus[] = [];
  private switchLog: SwitchLogEntry[] = [];

  getConfig(): FailoverConfig { return this.config; }
  saveConfig(c: FailoverConfig): void { this.config = c; }
  getStatuses(): ProviderStatus[] { return this.statuses; }
  saveStatuses(s: ProviderStatus[]): void { this.statuses = s; }
  upsertStatus(s: ProviderStatus): void {
    const i = this.statuses.findIndex((x) => x.id === s.id);
    if (i >= 0) this.statuses[i] = s; else this.statuses.push(s);
  }
  getSwitchLog(): SwitchLogEntry[] { return this.switchLog; }
  appendSwitchLog(e: SwitchLogEntry): void { this.switchLog.unshift(e); }
  clearSwitchLog(): void { this.switchLog = []; }
}

function provider(id: string, overrides: Partial<FakeProvider> = {}): FakeProvider {
  return {
    id,
    name: id,
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `key-${id}`,
    defaultModel: `model-${id}`,
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEngine(providers: FakeProvider[], config?: Partial<FailoverConfig>) {
  const storage = new FakeStorage();
  if (config) storage.saveConfig({ ...DEFAULT_CONFIG, ...config });
  const providerManager = { getAll: () => providers } as unknown as ConstructorParameters<typeof ProviderFailoverEngine>[1];
  const engine = new ProviderFailoverEngine(storage as unknown as ConstructorParameters<typeof ProviderFailoverEngine>[0], providerManager);
  return { engine, storage };
}

function resp<T = unknown>(status: number, body: T = {} as T): ProviderResponse<T> {
  return { ok: status >= 200 && status < 300, status, body };
}

// A primaryCall that returns a scripted sequence of statuses across calls.
function sequence(statuses: number[]) {
  let i = 0;
  let calls = 0;
  const fn = async () => {
    const s = statuses[Math.min(i, statuses.length - 1)];
    i++;
    calls++;
    return resp(s);
  };
  return { fn, getCalls: () => calls };
}

const ctx = (providerId: string, modelId = 'm') => ({ providerId, modelId, requestId: 'req-1' });

// ── executeWithFailover decision flow ──────────────────────────────────────────

describe('executeWithFailover decision flow', () => {
  it('healthy provider — returns immediately and marks HEALTHY', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    const out = await engine.executeWithFailover(
      async () => resp(200, { ok: 1 }),
      async () => resp(200),
      ctx('p1'),
    );
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'HEALTHY');
  });

  it('HTTP 429 then success — retries on same provider, no failover', async () => {
    const { engine } = makeEngine([provider('p1'), provider('p2')]);
    const primary = sequence([429, 200]);
    let altCalled = false;
    const out = await engine.executeWithFailover(
      primary.fn,
      async () => { altCalled = true; return resp(200); },
      ctx('p1'),
    );
    assert.equal(out.status, 200);
    assert.equal(altCalled, false, 'should not fail over when retry succeeds');
    assert.equal(primary.getCalls(), 2);
  });

  for (const status of [500, 502, 503, 504, 529]) {
    it(`HTTP ${status} exhausted — fails over to a healthy alternate`, async () => {
      const { engine, storage } = makeEngine([provider('p1'), provider('alt')]);
      let altProviderId = '';
      const out = await engine.executeWithFailover(
        async () => resp(status),
        async (alt: AltProvider) => { altProviderId = alt.id; return resp(200, { served: 'alt' }); },
        ctx('p1'),
      );
      assert.equal(out.ok, true);
      assert.equal(altProviderId, 'alt');
      // Primary marked unhealthy + cooled down; alt marked healthy.
      const p1 = storage.getStatuses().find((s) => s.id === 'p1');
      assert.equal(p1?.status, 'UNREACHABLE');
      assert.ok(p1?.cooldownUntil, 'primary should have a cooldown set');
      assert.equal(storage.getStatuses().find((s) => s.id === 'alt')?.status, 'HEALTHY');
      // Switch event logged.
      assert.equal(storage.getSwitchLog().length, 1);
      assert.equal(storage.getSwitchLog()[0].success, true);
    });
  }

  it('authentication failure (401) — no retry, fails over, primary marked AUTH_ERROR', async () => {
    const { engine, storage } = makeEngine([provider('p1'), provider('alt')]);
    const primary = sequence([401]);
    const out = await engine.executeWithFailover(
      primary.fn,
      async () => resp(200),
      ctx('p1'),
    );
    assert.equal(out.ok, true);
    assert.equal(primary.getCalls(), 1, '401 must not be retried on the same provider');
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'AUTH_ERROR');
  });

  it('network error (502 from transport) — fails over to alternate', async () => {
    const { engine } = makeEngine([provider('p1'), provider('alt')]);
    let altUsed = false;
    const out = await engine.executeWithFailover(
      async () => resp(502, { error: { type: 'network_error' } }),
      async () => { altUsed = true; return resp(200); },
      ctx('p1'),
    );
    assert.equal(out.ok, true);
    assert.equal(altUsed, true);
  });

  it('non-failover error (400) — returns immediately, no failover', async () => {
    const { engine } = makeEngine([provider('p1'), provider('alt')]);
    let altUsed = false;
    const out = await engine.executeWithFailover(
      async () => resp(400, { error: { message: 'bad request' } }),
      async () => { altUsed = true; return resp(200); },
      ctx('p1'),
    );
    assert.equal(out.status, 400);
    assert.equal(altUsed, false);
  });

  it('multi-provider chain — first alternate fails, second succeeds', async () => {
    const { engine, storage } = makeEngine([provider('p1'), provider('alt1'), provider('alt2')]);
    const used: string[] = [];
    const out = await engine.executeWithFailover(
      async () => resp(503),
      async (alt: AltProvider) => {
        used.push(alt.id);
        return alt.id === 'alt2' ? resp(200, { served: 'alt2' }) : resp(500);
      },
      ctx('p1'),
    );
    assert.equal(out.ok, true);
    assert.deepEqual(used, ['alt1', 'alt2']);
    assert.equal(storage.getStatuses().find((s) => s.id === 'alt2')?.status, 'HEALTHY');
  });

  it('all providers unavailable — returns 503 overloaded response', async () => {
    const { engine } = makeEngine([provider('p1'), provider('alt1')]);
    const out = await engine.executeWithFailover(
      async () => resp(500),
      async () => resp(500),
      ctx('p1'),
    );
    assert.equal(out.ok, false);
    assert.equal(out.status, 503);
  });

  it('failover disabled — single attempt, success marks healthy', async () => {
    const { engine, storage } = makeEngine([provider('p1')], { failover_enabled: false });
    const out = await engine.executeWithFailover(
      async () => resp(200),
      async () => resp(200),
      ctx('p1'),
    );
    assert.equal(out.ok, true);
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'HEALTHY');
  });
});

// ── Cooldown / recovery ────────────────────────────────────────────────────────

describe('cooldown and recovery', () => {
  it('a cooled-down provider is excluded from alternates, then recovers', async () => {
    const { engine } = makeEngine([provider('p1'), provider('cool'), provider('ok')]);
    // Put 'cool' into cooldown via a passive hard-failure mark.
    engine.markProviderStatus('cool', 'UNREACHABLE', 'boom');
    const alts = engine.getAlternateProviders('p1');
    assert.ok(!alts.find((a) => a.id === 'cool'), 'cooled-down provider must be excluded');
    assert.ok(alts.find((a) => a.id === 'ok'), 'healthy provider remains selectable');
  });

  it('a successful real request clears the cooldown immediately (recovery)', async () => {
    // Three providers so the cooldown exclusion is observable (with only one
    // alternate, the never-zero invariant would surface it regardless).
    const { engine } = makeEngine([provider('p1'), provider('cool'), provider('ok')]);
    engine.markProviderStatus('cool', 'AUTH_ERROR', '401');
    // While cooled down, the healthy 'ok' provider is preferred and 'cool' is excluded.
    const before = engine.getAlternateProviders('p1');
    assert.equal(before[0]?.id, 'ok', 'healthy provider ranks first');
    assert.ok(!before.find((a) => a.id === 'cool'), 'cooled-down provider excluded while alternatives exist');
    // Live traffic succeeds → mark HEALTHY → cooldown cleared → eligible again.
    engine.markProviderStatus('cool', 'HEALTHY', '');
    assert.ok(engine.getAlternateProviders('p1').find((a) => a.id === 'cool'));
  });

  it('error counts are capped (never grow unbounded)', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    for (let i = 0; i < 250; i++) engine.markProviderStatus('p1', 'UNREACHABLE', 'x');
    const ec = storage.getStatuses().find((s) => s.id === 'p1')?.errorCount ?? 0;
    assert.ok(ec <= 100, `errorCount should be capped at 100, got ${ec}`);
  });
});

// ── Active health check classification (authoritative probe) ───────────────────

describe('active health check — authoritative probe', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  // Route fetch by URL substring + method to a scripted handler.
  function stubFetch(handler: (url: string, method: string) => { status: number } | 'throw') {
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const r = handler(url, method);
      if (r === 'throw') throw new Error('network down');
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: () => null },
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it('GET /models 2xx → HEALTHY (fast path, no chat probe)', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    let chatHit = false;
    stubFetch((url) => {
      if (url.includes('/chat/completions')) { chatHit = true; return { status: 200 }; }
      return { status: 200 };
    });
    await engine.runHealthChecks();
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'HEALTHY');
    assert.equal(chatHit, false, 'chat probe should be skipped when /models is 2xx');
  });

  it('GET /models 404 but chat 200 → HEALTHY (provider has no /models)', async () => {
    const { engine, storage } = makeEngine([provider('gh')]);
    stubFetch((url) => (url.includes('/chat/completions') ? { status: 200 } : { status: 404 }));
    await engine.runHealthChecks();
    assert.equal(storage.getStatuses().find((s) => s.id === 'gh')?.status, 'HEALTHY');
  });

  it('GET /models 401 and chat 401 — single probe stays DEGRADED, escalates to AUTH_ERROR after threshold', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    stubFetch(() => ({ status: 401 }));

    // First failing probe must NOT hard-down a provider — it only degrades it.
    await engine.runHealthChecks();
    const after1 = storage.getStatuses().find((s) => s.id === 'p1');
    assert.equal(after1?.status, 'DEGRADED', 'one bad probe should only DEGRADE');
    assert.equal(after1?.cooldownUntil, undefined, 'DEGRADED carries no cooldown');

    // Three consecutive failures (threshold) → genuine hard-down.
    await engine.runHealthChecks();
    await engine.runHealthChecks();
    const after3 = storage.getStatuses().find((s) => s.id === 'p1');
    assert.equal(after3?.status, 'AUTH_ERROR', 'threshold reached → AUTH_ERROR');
    assert.equal(after3?.consecutiveFailures, 3);
  });

  it('GET /models 500 but chat rejects request with 400 → HEALTHY (reachable + authed)', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    stubFetch((url) => (url.includes('/chat/completions') ? { status: 400 } : { status: 500 }));
    await engine.runHealthChecks();
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'HEALTHY');
  });

  it('both /models and chat throw (DNS/network failure) → DEGRADED first, UNREACHABLE after 3 consecutive', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    stubFetch(() => 'throw');

    await engine.runHealthChecks();
    const s1 = storage.getStatuses().find((x) => x.id === 'p1');
    assert.equal(s1?.status, 'DEGRADED', 'a single transport failure must not hard-down a provider');
    assert.equal(s1?.cooldownUntil, undefined);

    await engine.runHealthChecks();
    await engine.runHealthChecks();
    const s3 = storage.getStatuses().find((x) => x.id === 'p1');
    assert.equal(s3?.status, 'UNREACHABLE', 'three consecutive failures → UNREACHABLE');
    assert.ok(s3?.cooldownUntil, 'unreachable provider should be cooled down');
  });

  it('a passing probe resets consecutive failures (glitch recovery)', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    // Two transport-failing rounds degrade the provider...
    stubFetch(() => 'throw');
    await engine.runHealthChecks();
    await engine.runHealthChecks();
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.consecutiveFailures, 2);
    // Now a healthy round resets the counter and clears any degraded state.
    stubFetch(() => ({ status: 200 }));
    await engine.runHealthChecks();
    const s = storage.getStatuses().find((x) => x.id === 'p1');
    assert.equal(s?.status, 'HEALTHY');
    assert.equal(s?.consecutiveFailures, 0);
    // A subsequent single failure must start over at DEGRADED, not jump to hard-down.
    stubFetch(() => 'throw');
    await engine.runHealthChecks();
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'DEGRADED');
  });
});

// ── Startup race / grace window ────────────────────────────────────────────────

describe('startup grace + transient-glitch tolerance', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubThrow() {
    globalThis.fetch = (async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch;
  }

  it('during startup grace, even repeated probe failures never escalate past DEGRADED', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    engine.beginStartupGrace(); // open a 30s grace window
    assert.equal(engine.isInStartupGrace(), true);
    stubThrow();
    // Far more than the failure threshold — still must not hard-down or cooldown.
    for (let i = 0; i < 5; i++) await engine.runHealthChecks();
    const s = storage.getStatuses().find((x) => x.id === 'p1');
    assert.equal(s?.status, 'DEGRADED', 'grace window must keep providers routable');
    assert.equal(s?.cooldownUntil, undefined, 'no cooldown during grace');
  });

  it('a DEGRADED provider remains a routable failover candidate', async () => {
    const { engine } = makeEngine([provider('p1'), provider('degraded')]);
    engine.beginStartupGrace();
    // Degrade the alternate via a passive-ish active failure during grace.
    globalThis.fetch = (async (input: unknown) => {
      // Only the 'degraded' provider's URLs throw.
      if (String(input).includes('degraded')) throw new Error('fetch failed');
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await engine.runHealthChecks();
    const alts = engine.getAlternateProviders('p1');
    assert.ok(alts.find((a) => a.id === 'degraded'), 'DEGRADED provider must still be selectable for failover');
  });

  it('a real successful request immediately overrides a DEGRADED active probe (passive wins)', async () => {
    const { engine, storage } = makeEngine([provider('p1')]);
    engine.beginStartupGrace();
    stubThrow();
    await engine.runHealthChecks();
    assert.equal(storage.getStatuses().find((s) => s.id === 'p1')?.status, 'DEGRADED');
    // Live traffic succeeds → reconcile to HEALTHY instantly.
    engine.markProviderStatus('p1', 'HEALTHY', '');
    const s = storage.getStatuses().find((x) => x.id === 'p1');
    assert.equal(s?.status, 'HEALTHY');
    assert.equal(s?.consecutiveFailures, 0);
  });
});

// ── Never-zero candidate invariant ─────────────────────────────────────────────

describe('failover router never has zero candidates', () => {
  it('falls back to the full pool when every alternate is cooled down', async () => {
    const { engine } = makeEngine([provider('p1'), provider('a'), provider('b')]);
    // Hard-down both alternates so they enter cooldown (passive = authoritative).
    engine.markProviderStatus('a', 'UNREACHABLE', 'boom');
    engine.markProviderStatus('b', 'UNREACHABLE', 'boom');
    const alts = engine.getAlternateProviders('p1');
    assert.equal(alts.length, 2, 'must still offer candidates rather than an empty pool');
  });

  it('still fails over to a cooled-down provider when it is the only option and it now works', async () => {
    const { engine, storage } = makeEngine([provider('p1'), provider('only')]);
    engine.markProviderStatus('only', 'UNREACHABLE', 'boom'); // cooled down
    const out = await engine.executeWithFailover(
      async () => resp(503),
      async () => resp(200, { served: 'only' }),
      ctx('p1'),
    );
    assert.equal(out.ok, true, 'a recovering provider beats "all unavailable"');
    assert.equal(storage.getStatuses().find((s) => s.id === 'only')?.status, 'HEALTHY');
  });
});

// ── Precise transport-error reporting ──────────────────────────────────────────

describe('describeFetchError — exact transport cause', () => {
  it('classifies common syscall codes instead of "fetch failed"', () => {
    const mk = (code: string) => Object.assign(new Error('fetch failed'), { cause: { code } });
    assert.match(describeFetchError(mk('ENOTFOUND')), /DNS/);
    assert.match(describeFetchError(mk('ECONNREFUSED')), /refused/i);
    assert.match(describeFetchError(mk('ETIMEDOUT')), /timed out/i);
    assert.match(describeFetchError(mk('CERT_HAS_EXPIRED')), /TLS|certificate/i);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    assert.match(describeFetchError(abort), /timed out/i);
  });
});
