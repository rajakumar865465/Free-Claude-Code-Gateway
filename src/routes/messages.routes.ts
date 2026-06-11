import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service';
import { anthropicError, mapOpenAIErrorToAnthropic } from '../converters/errors';
import { convertOpenAIResponseToAnthropic } from '../converters/openai-to-anthropic';
import { validateAndConvertAnthropicRequest } from '../converters/anthropic-to-openai';
import { getLogger } from '../utils/logger';
import { getConfig } from '../config/env';
import { CircuitBreaker } from '../utils/circuit-breaker';
import type {
  OpenAIChatCompletionsRequest,
  OpenAIChatCompletionsResponse,
  OpenAIErrorResponse,
  OpenAIStreamChunk,
} from '../types/openai';
import type { AnthropicStreamEvent } from '../types/anthropic';
import { mapFinishReason } from '../converters/openai-to-anthropic';
import type { AdminState } from '../admin/admin-state';

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Write to the response only if it hasn't already been ended. */
function safeWrite(res: Response, data: string): void {
  if (!res.writableEnded) res.write(data);
}

/** End the response only if it hasn't already been ended. */
function safeEnd(res: Response): void {
  if (!res.writableEnded) res.end();
}

/**
 * Compact error serializer for logs. Raw DOMException/Error objects dumped into
 * pino include dozens of constant properties (INDEX_SIZE_ERR ... DATA_CLONE_ERR)
 * which spam the logs. This extracts just the useful fields.
 */
function errInfo(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'UnknownError', message: String(err) };
}

// Accumulator for a streaming tool call being assembled across deltas
interface ToolCallAccum {
  id: string;
  name: string;
  argumentsJson: string;
}

// Singleton circuit breaker — shared across all requests in this process.
// Keyed by providerModel string.
let _circuitBreaker: CircuitBreaker | null = null;
function getCircuitBreaker(): CircuitBreaker {
  if (!_circuitBreaker) {
    const cfg = getConfig();
    _circuitBreaker = new CircuitBreaker({
      failureThreshold: cfg.circuitBreakerFailures,
      recoveryMs: cfg.circuitBreakerRecoveryMs,
      rollingMs: cfg.circuitBreakerRollingMs,
    });
  }
  return _circuitBreaker;
}

// Exported for tests
export function resetCircuitBreaker(): void {
  _circuitBreaker = null;
}

async function handleStreaming(
  _req: Request,
  res: Response,
  service: BluesmindsService,
  providerModel: string,
  originalClientModel: string,
  streamBody: OpenAIChatCompletionsRequest,
  state: AdminState,
  backupModel: string | null,
): Promise<void> {
  const logger = getLogger();
  const cfg = getConfig();
  const startTime = _req.startTime ?? Date.now();
  let inputTokens = 0;
  // Declare outputTokens early so tryNonStreamFallback (defined below) can
  // access it even when called before the main stream loop.
  let outputTokens = 0;
  let errorMsg: string | undefined;
  const cb = getCircuitBreaker();

  // ── Idle-chunk timeout setup ──────────────────────────────────────────────
  const IDLE_TIMEOUT_MS = cfg.idleTimeoutMs;
  const KEEP_ALIVE_PING_MS = cfg.keepAlivePingMs;

  const idleAbortController = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleTriggered = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let headersWritten = false;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTriggered = true;
      logger.warn({ idleTimeoutMs: IDLE_TIMEOUT_MS, providerModel }, 'stream_idle_timeout');
      idleAbortController.abort();
    }, IDLE_TIMEOUT_MS);
  };

  const clearIdleTimer = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  const startKeepAlive = () => {
    if (KEEP_ALIVE_PING_MS <= 0 || !headersWritten) return;
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      safeWrite(res, ': ping\n\n');
    }, KEEP_ALIVE_PING_MS);
  };

  const stopKeepAlive = () => {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  };

  // Helper: open a stream connection and return the reader
  async function openStream(model: string, isBackup: boolean): Promise<
    | { ok: true; reader: ReadableStreamDefaultReader<Uint8Array>; cascaded: boolean }
    | { ok: false; status: number; body: unknown }
  > {
    const result = await service.createChatCompletionStream(
      { ...streamBody, model, stream: true },
      isBackup ? null : backupModel,
      idleAbortController.signal,
    );
    if (!result.ok) return result;
    const body = result.response.body;
    if (!body) {
      return { ok: false, status: 502, body: { error: { message: 'No response body', type: 'api_error' } } };
    }
    const cascadedFlag = (result as { cascadedToBackup?: boolean }).cascadedToBackup === true || isBackup;
    return { ok: true, reader: body.getReader(), cascaded: cascadedFlag };
  }

  // ── Non-stream fallback ───────────────────────────────────────────────────
  // When a streaming attempt fails (504 / idle-abort), send a plain request and
  // re-emit the response as Anthropic SSE events.
  async function tryNonStreamFallback(model: string): Promise<boolean> {
    logger.warn(
      { providerModel: model, fallback: 'non_stream' },
      'stream_fallback_non_stream_attempt',
    );

    let result: Awaited<ReturnType<typeof service.createChatCompletionNonStream>>;
    try {
      result = await service.createChatCompletionNonStream({ ...streamBody, model });
    } catch (fetchErr) {
      logger.error(
        { providerModel: model, err: fetchErr, fallback: 'non_stream' },
        'stream_fallback_non_stream_fetch_threw',
      );
      return false;
    }

    if (!result.ok) {
      logger.error(
        { providerModel: model, status: result.status, fallback: 'non_stream' },
        'stream_fallback_non_stream_failed',
      );
      return false;
    }

    const body = result.body as OpenAIChatCompletionsResponse;
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? '';
    const finishReason = mapFinishReason(choice?.finish_reason ?? null);
    if (body.usage) {
      inputTokens = body.usage.prompt_tokens ?? 0;
      outputTokens = body.usage.completion_tokens ?? 0;
    }

    // Guard: don't write to an already-ended response
    if (res.writableEnded) return false;

    // Emit SSE headers if not yet sent
    if (!headersWritten) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      headersWritten = true;
    }

    const messageId = `msg_${Date.now()}`;
    safeWrite(res, sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    } satisfies AnthropicStreamEvent));
    safeWrite(res, sseEvent('ping', { type: 'ping' } satisfies AnthropicStreamEvent));
    if (content) {
      safeWrite(res, sseEvent('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      } satisfies AnthropicStreamEvent));
      safeWrite(res, sseEvent('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: content },
      } satisfies AnthropicStreamEvent));
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop', index: 0,
      } satisfies AnthropicStreamEvent));
    }
    safeWrite(res, sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: finishReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    } satisfies AnthropicStreamEvent));
    safeWrite(res, sseEvent('message_stop', { type: 'message_stop' } satisfies AnthropicStreamEvent));
    safeEnd(res);

    logger.warn(
      { providerModel: model, fallback: 'non_stream', inputTokens, outputTokens },
      'stream_fallback_non_stream_ok',
    );
    return true;
  }

  // ── Circuit breaker check ─────────────────────────────────────────────────
  // When the circuit is OPEN, skip the stream attempt entirely and go straight
  // to non-stream fallback. This avoids another 12s connect timeout on a
  // provider that is already known to be failing its streaming endpoint.
  if (!cb.allowRequest(providerModel)) {
    const snap = cb.snapshot(providerModel);
    logger.warn(
      { providerModel, circuit: 'open', ...snap },
      'circuit_breaker_open_skip_to_fallback',
    );
    // Flush SSE headers so the fallback can write events
    if (!headersWritten) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      headersWritten = true;
    }
    const fallbackOk = await tryNonStreamFallback(providerModel);
    if (fallbackOk) {
      state.requestLog.record({
        endpoint: _req.originalUrl || _req.url,
        method: _req.method,
        clientModel: originalClientModel,
        resolvedModel: providerModel,
        status: 200,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
        streaming: true,
        error: undefined,
        fallback: 'non_stream',
      });
      return;
    }
    // Non-stream fallback also failed — return 503 via SSE error event
    if (!res.writableEnded) {
      safeWrite(res, sseEvent('error', {
        type: 'error',
        error: { type: 'overloaded_error', message: `Provider model ${providerModel} is temporarily unavailable. Try again shortly.` },
      } satisfies AnthropicStreamEvent));
      safeEnd(res);
    }
    state.requestLog.record({
      endpoint: _req.originalUrl || _req.url,
      method: _req.method,
      clientModel: originalClientModel,
      resolvedModel: providerModel,
      status: 503,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      streaming: true,
      error: 'circuit_open_fallback_failed',
    });
    return;
  }

  // ── Open primary stream ───────────────────────────────────────────────────
  const streamResult = await openStream(providerModel, false);

  if (!streamResult.ok) {
    const errBody = streamResult.body as { error?: { message?: string; type?: string } };
    const message = errBody?.error?.message ?? 'Upstream stream request failed';

    // 504 / 503 on initial connect → record circuit failure, attempt non-stream fallback
    if (streamResult.status === 504 || streamResult.status === 503) {
      const newState = cb.recordFailure(providerModel);
      logger.warn(
        { providerModel, status: streamResult.status, circuit: newState, fallback: 'non_stream' },
        'stream_504_fallback_attempt',
      );
      // Flush SSE headers so the fallback can write events
      if (!headersWritten) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        headersWritten = true;
      }
      const fallbackOk = await tryNonStreamFallback(providerModel);
      if (fallbackOk) {
        state.requestLog.record({
          endpoint: _req.originalUrl || _req.url,
          method: _req.method,
          clientModel: originalClientModel,
          resolvedModel: providerModel,
          status: 200,
          inputTokens,
          outputTokens,
          latencyMs: Date.now() - startTime,
          streaming: true,
          error: undefined,
          fallback: 'non_stream',
        });
        return;
      }
      // Fallback also failed — fall through to the error response below
    }

    const mapped = mapOpenAIErrorToAnthropic({
      status: streamResult.status,
      body: { error: { message, type: errBody?.error?.type } },
    });
    if (!headersWritten) {
      res.status(mapped.status).json(mapped.body);
    } else if (!res.writableEnded) {
      safeWrite(res, sseEvent('error', {
        type: 'error', error: { type: 'api_error', message },
      } satisfies AnthropicStreamEvent));
      safeEnd(res);
    }
    state.requestLog.record({
      endpoint: _req.originalUrl || _req.url,
      method: _req.method,
      clientModel: originalClientModel,
      resolvedModel: providerModel,
      status: mapped.status,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startTime,
      streaming: true,
      error: message,
    });
    return;
  }

  let { reader } = streamResult;
  let cascaded = streamResult.cascaded;

  // ── SSE headers ───────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  headersWritten = true;

  const messageId = `msg_${Date.now()}`;

  safeWrite(res, sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: providerModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } satisfies AnthropicStreamEvent));

  safeWrite(res, sseEvent('ping', { type: 'ping' } satisfies AnthropicStreamEvent));

  let stopReason = 'end_turn';
  let buffer = '';
  let fallbackUsed: 'non_stream' | undefined;

  // Track open content blocks
  let textBlockOpen = false;
  let textBlockIndex = -1;
  const toolAccums = new Map<number, { blockIndex: number; accum: ToolCallAccum }>();
  let nextBlockIndex = 0;

  function openTextBlock(): void {
    if (textBlockOpen) return;
    textBlockOpen = true;
    textBlockIndex = nextBlockIndex++;
    safeWrite(res, sseEvent('content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' },
    } satisfies AnthropicStreamEvent));
  }

  // ── Stream reader loop ────────────────────────────────────────────────────
  const decoder = new TextDecoder();

  // Start idle timer + keep-alive pings
  resetIdleTimer();
  startKeepAlive();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Got a chunk — stream is alive, reset idle timer, stop keep-alive pings
      resetIdleTimer();
      stopKeepAlive(); // no need once real data is flowing

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data:')) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) {
            if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
            if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
          }
          continue;
        }

        const delta = choice.delta;

        // ── Text delta ──────────────────────────────────────────────
        if (delta?.content) {
          openTextBlock();
          safeWrite(res, sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          } satisfies AnthropicStreamEvent));
          outputTokens++;
        }

        // ── Tool call deltas ────────────────────────────────────────
        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index ?? 0;

            if (!toolAccums.has(idx)) {
              const blockIndex = nextBlockIndex++;
              const accum: ToolCallAccum = {
                id: tcDelta.id ?? `tool_${idx}`,
                name: tcDelta.function?.name ?? '',
                argumentsJson: '',
              };
              toolAccums.set(idx, { blockIndex, accum });
              safeWrite(res, sseEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                  type: 'tool_use',
                  id: accum.id,
                  name: accum.name,
                  input: {},
                },
              }));
            }

            const entry = toolAccums.get(idx)!;
            if (tcDelta.id) entry.accum.id = tcDelta.id;
            if (tcDelta.function?.name) entry.accum.name += tcDelta.function.name;
            if (tcDelta.function?.arguments) {
              entry.accum.argumentsJson += tcDelta.function.arguments;
              safeWrite(res, sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: entry.blockIndex,
                delta: { type: 'input_json_delta', partial_json: tcDelta.function.arguments },
              }));
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
          if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
        }
      }
    }

    // Stream completed successfully — record circuit success
    cb.recordSuccess(providerModel);

  } catch (err) {
    clearIdleTimer();
    stopKeepAlive();

    const isIdleAbort = idleTriggered || idleAbortController.signal.aborted;
    const isStreamError = err instanceof Error;

    // Record circuit failure for idle aborts and network errors
    if (isIdleAbort || (isStreamError && !cascaded)) {
      const newState = cb.recordFailure(providerModel);
      logger.warn(
        { providerModel, circuit: newState, isIdleAbort },
        'stream_circuit_failure_recorded',
      );
    }

    // ── Idle timeout with backup available → try backup stream ────────────
    if (isIdleAbort && backupModel && !cascaded) {
      logger.warn({ primaryModel: providerModel, backupModel, outputTokensSoFar: outputTokens }, 'stream_idle_cascade_to_backup');

      idleTriggered = false;
      const backupResult = await openStream(backupModel, true);

      if (backupResult.ok) {
        cascaded = true;
        reader = backupResult.reader;
        buffer = '';
        resetIdleTimer();
        startKeepAlive();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdleTimer();
            stopKeepAlive();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed === 'data: [DONE]') continue;
              if (!trimmed.startsWith('data:')) continue;
              const jsonStr = trimmed.slice(5).trim();
              if (!jsonStr) continue;
              let chunk: OpenAIStreamChunk;
              try { chunk = JSON.parse(jsonStr); } catch { continue; }
              const choice = chunk.choices?.[0];
              if (!choice) {
                if (chunk.usage) {
                  if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
                  if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
                }
                continue;
              }
              const delta = choice.delta;
              if (delta?.content) {
                openTextBlock();
                safeWrite(res, sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: textBlockIndex,
                  delta: { type: 'text_delta', text: delta.content },
                } satisfies AnthropicStreamEvent));
                outputTokens++;
              }
              if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
              if (chunk.usage) {
                if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
                if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
              }
            }
          }
          cb.recordSuccess(backupModel);
        } catch (backupErr) {
          errorMsg = backupErr instanceof Error ? backupErr.message : 'Backup stream failed';
          logger.error({ err: errInfo(backupErr) }, 'backup_stream_read_error');
          // Backup stream also stalled — try non-stream fallback on backup
          stopKeepAlive();
          clearIdleTimer();
          const fallbackOk = await tryNonStreamFallback(backupModel);
          if (fallbackOk) {
            fallbackUsed = 'non_stream';
            errorMsg = undefined;
          } else if (!res.writableEnded) {
            safeWrite(res, sseEvent('error', {
              type: 'error',
              error: { type: 'api_error', message: errorMsg },
            } satisfies AnthropicStreamEvent));
            safeEnd(res);
            state.requestLog.record({
              endpoint: _req.originalUrl || _req.url,
              method: _req.method,
              clientModel: originalClientModel,
              resolvedModel: providerModel,
              status: 500,
              inputTokens,
              outputTokens,
              latencyMs: Date.now() - startTime,
              streaming: true,
              error: errorMsg,
            });
            return;
          }
        } finally {
          clearIdleTimer();
          stopKeepAlive();
        }
        if (fallbackUsed === 'non_stream') return; // already ended
        // Fall through to write close events below
      } else {
        // Backup stream connection also failed — try non-stream fallback
        logger.error({ primaryModel: providerModel, backupModel, backupStatus: backupResult.status }, 'backup_stream_failed');
        const fallbackOk = await tryNonStreamFallback(backupModel);
        if (fallbackOk) {
          state.requestLog.record({
            endpoint: _req.originalUrl || _req.url,
            method: _req.method,
            clientModel: originalClientModel,
            resolvedModel: backupModel,
            status: 200,
            inputTokens,
            outputTokens,
            latencyMs: Date.now() - startTime,
            streaming: true,
            error: undefined,
            fallback: 'non_stream',
          });
          return;
        }
        errorMsg = `Primary stalled, backup also failed (${backupResult.status})`;
        if (!res.writableEnded) {
          safeWrite(res, sseEvent('error', {
            type: 'error',
            error: { type: 'api_error', message: errorMsg },
          } satisfies AnthropicStreamEvent));
          safeEnd(res);
        }
        state.requestLog.record({
          endpoint: _req.originalUrl || _req.url,
          method: _req.method,
          clientModel: originalClientModel,
          resolvedModel: providerModel,
          status: 500,
          inputTokens,
          outputTokens,
          latencyMs: Date.now() - startTime,
          streaming: true,
          error: errorMsg,
        });
        return;
      }
    } else if (isIdleAbort) {
      // Idle abort, no backup — try non-stream fallback on primary
      const fallbackOk = await tryNonStreamFallback(providerModel);
      if (fallbackOk) {
        state.requestLog.record({
          endpoint: _req.originalUrl || _req.url,
          method: _req.method,
          clientModel: originalClientModel,
          resolvedModel: providerModel,
          status: 200,
          inputTokens,
          outputTokens,
          latencyMs: Date.now() - startTime,
          streaming: true,
          error: undefined,
          fallback: 'non_stream',
        });
        return;
      }
      errorMsg = 'Stream timed out and non-stream fallback also failed';
      logger.error({ providerModel, err: errInfo(err) }, 'stream_read_error');
      if (!res.writableEnded) {
        safeWrite(res, sseEvent('error', {
          type: 'error',
          error: { type: 'api_error', message: errorMsg },
        } satisfies AnthropicStreamEvent));
        safeEnd(res);
      }
      state.requestLog.record({
        endpoint: _req.originalUrl || _req.url,
        method: _req.method,
        clientModel: originalClientModel,
        resolvedModel: providerModel,
        status: 500,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
        streaming: true,
        error: errorMsg,
      });
      return;
    } else {
      // Regular non-idle stream error — report and close
      errorMsg = err instanceof Error ? err.message : 'Stream read failed';
      logger.error({ err: errInfo(err), isIdleAbort }, 'stream_read_error');
      if (!res.writableEnded) {
        safeWrite(res, sseEvent('error', {
          type: 'error',
          error: { type: 'api_error', message: errorMsg },
        } satisfies AnthropicStreamEvent));
        safeEnd(res);
      }
      state.requestLog.record({
        endpoint: _req.originalUrl || _req.url,
        method: _req.method,
        clientModel: originalClientModel,
        resolvedModel: providerModel,
        status: 500,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
        streaming: true,
        error: errorMsg,
      });
      return;
    }
  } finally {
    clearIdleTimer();
    stopKeepAlive();
  }

  // ── Close SSE stream ──────────────────────────────────────────────────────
  if (res.writableEnded) return; // already closed by fallback path

  if (textBlockOpen) {
    safeWrite(res, sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: textBlockIndex,
    } satisfies AnthropicStreamEvent));
  }

  for (const [, entry] of toolAccums) {
    safeWrite(res, sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: entry.blockIndex,
    } satisfies AnthropicStreamEvent));
  }

  safeWrite(res, sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } satisfies AnthropicStreamEvent));

  safeWrite(res, sseEvent('message_stop', { type: 'message_stop' } satisfies AnthropicStreamEvent));

  safeEnd(res);

  state.requestLog.record({
    endpoint: _req.originalUrl || _req.url,
    method: _req.method,
    clientModel: originalClientModel,
    resolvedModel: cascaded && backupModel ? backupModel : providerModel,
    status: 200,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - startTime,
    streaming: true,
    error: errorMsg,
    cascadedToBackup: cascaded || undefined,
  });
}

export function buildMessagesRouter(service: BluesmindsService, state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  router.post('/v1/messages', async (req: Request, res: Response) => {
    try {
      const conversion = validateAndConvertAnthropicRequest(req.body);
      if (!conversion.ok) {
        res.status(conversion.status).json(conversion.body);
        return;
      }

      const clientModel = (req.body as { model?: unknown })?.model;
      const originalClientModel = typeof clientModel === 'string' ? clientModel : '';

      let providerModel: string;
      let backupModel: string | null = null;
      try {
        const resolved = state.modelRegistry.resolveWithBackup(
          conversion.request.model || undefined,
          state.configManager.getDefaultModel(),
          state.configManager.isStrictMapping(),
        );
        providerModel = resolved.primary;
        backupModel = resolved.backup;
        if (backupModel === null) {
          const defaultModel = state.configManager.getDefaultModel();
          if (defaultModel && defaultModel !== providerModel) {
            backupModel = defaultModel;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Model resolution failed.';
        res.status(400).json(anthropicError('invalid_request_error', message, 400).body);
        return;
      }

      res.locals = { ...(res.locals ?? {}), providerModel };

      const wantsStream = (req.body as { stream?: boolean }).stream === true;
      if (wantsStream) {
        res.locals = { ...(res.locals ?? {}), __skipLogCapture: true };
        await handleStreaming(req, res, service, providerModel, originalClientModel, conversion.request, state, backupModel);
        return;
      }

      // Non-streaming path
      const openaiRequest = { ...conversion.request, model: providerModel, stream: false };
      const upstream = await service.createChatCompletion(openaiRequest, backupModel);

      if (!upstream.ok) {
        const mapped = mapOpenAIErrorToAnthropic(upstream.body as OpenAIErrorResponse);
        if (mapped.body.error.type === 'timeout_error') {
          logger.warn({ providerModel, status: mapped.status }, 'upstream_timeout');
        } else if (mapped.body.error.type === 'permission_error') {
          logger.warn({ providerModel, status: mapped.status }, 'upstream_permission_error');
        } else {
          logger.warn({ providerModel, status: mapped.status, type: mapped.body.error.type }, 'upstream_error');
        }
        res.status(mapped.status).json(mapped.body);
        return;
      }

      const cascaded = upstream.cascadedToBackup === true;
      const servedByModel = cascaded && backupModel ? backupModel : providerModel;

      const anthropicResponse = convertOpenAIResponseToAnthropic(
        upstream.body as OpenAIChatCompletionsResponse,
        servedByModel,
      );

      res.status(200).json(anthropicResponse);
    } catch (err) {
      // Top-level catch: prevents unhandled rejections from async handler.
      // At this point headers may or may not have been sent.
      const logger = getLogger();
      const message = err instanceof Error ? err.message : 'Internal server error';
      logger.error({ err: errInfo(err) }, 'messages_route_unhandled_error');
      if (!res.headersSent) {
        res.status(500).json(
          anthropicError('api_error', message, 500).body,
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return router;
}
