import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service';
import { anthropicError, mapOpenAIErrorToAnthropic } from '../converters/errors';
import { convertOpenAIResponseToAnthropic } from '../converters/openai-to-anthropic';
import { validateAndConvertAnthropicRequest } from '../converters/anthropic-to-openai';
import { getLogger } from '../utils/logger';
import { convertAnthropicToResponsesRequest, convertResponsesToAnthropic } from '../utils/responses-mapper';
import { getConfig } from '../config/env';
import { CircuitBreaker } from '../utils/circuit-breaker';
import type {
  OpenAIChatCompletionsRequest,
  OpenAIChatCompletionsResponse,
  OpenAIErrorResponse,
  OpenAIStreamChunk,
  OpenAIErrorBody,
} from '../types/openai';
import type { AnthropicStreamEvent } from '../types/anthropic';
import { mapFinishReason } from '../converters/openai-to-anthropic';
import type { AdminState } from '../admin/admin-state';
import { getBedrockBaseUrl } from '../utils/bedrock-url';

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

export async function collectResponsesCompletion(
  service: BluesmindsService,
  responsesBody: Record<string, unknown>,
): Promise<
  | { ok: true; status: number; body: any }
  | { ok: false; status: number; body: unknown }
> {
  const upstream = await service.createResponsesCompletionStream(responsesBody);
  if (!upstream.ok) return upstream;

  const stream = upstream.response.body;
  if (!stream) {
    return {
      ok: false,
      status: 502,
      body: { error: { type: 'api_error', message: 'Azure Responses stream returned no body' } },
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: any;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          finalResponse = event.response;
        } else if (event.type === 'response.failed' || event.type === 'error') {
          return {
            ok: false,
            status: 502,
            body: {
              error: {
                type: 'api_error',
                message: event.response?.error?.message || event.error?.message || event.message || 'Azure Responses stream failed',
              },
            },
          };
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      body: {
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
    };
  } finally {
    reader.releaseLock();
  }

  if (!finalResponse) {
    return {
      ok: false,
      status: 502,
      body: { error: { type: 'api_error', message: 'Azure Responses stream ended before completion' } },
    };
  }
  return { ok: true, status: 200, body: finalResponse };
}
export async function handleResponsesStreaming(
  res: Response,
  service: BluesmindsService,
  responsesBody: Record<string, unknown>,
  providerModel: string,
): Promise<void> {
  const upstream = await service.createResponsesCompletionStream(responsesBody);
  if (!upstream.ok) {
    const mapped = mapOpenAIErrorToAnthropic({
      status: upstream.status,
      body: upstream.body as OpenAIErrorBody,
    });
    res.status(mapped.status).json(mapped.body);
    return;
  }

  const body = upstream.response.body;
  if (!body) {
    res.status(502).json(anthropicError('api_error', 'Azure Responses stream returned no body', 502).body);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  safeWrite(res, sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: providerModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));
  safeWrite(res, sseEvent('ping', { type: 'ping' }));

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let nextBlockIndex = 0;
  let textBlockIndex: number | null = null;
  let streamedText = '';
  let completed = false;
  let outputTokens = 0;
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
  const tools = new Map<number, {
    blockIndex: number;
    id: string;
    name: string;
    argumentsJson: string;
    closed: boolean;
  }>();

  const openText = (): number => {
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextBlockIndex++;
    safeWrite(res, sseEvent('content_block_start', {
      type: 'content_block_start', index: textBlockIndex,
      content_block: { type: 'text', text: '' },
    }));
    return textBlockIndex;
  };

  const emitText = (delta: string): void => {
    if (!delta) return;
    const index = openText();
    streamedText += delta;
    safeWrite(res, sseEvent('content_block_delta', {
      type: 'content_block_delta', index,
      delta: { type: 'text_delta', text: delta },
    }));
  };

  const openTool = (outputIndex: number, item: any): ReturnType<typeof tools.get> => {
    const existing = tools.get(outputIndex);
    if (existing) return existing;
    const tool = {
      blockIndex: nextBlockIndex++,
      id: item?.call_id || item?.id || `call_${Date.now()}_${outputIndex}`,
      name: item?.name || 'unknown_tool',
      argumentsJson: '',
      closed: false,
    };
    tools.set(outputIndex, tool);
    safeWrite(res, sseEvent('content_block_start', {
      type: 'content_block_start', index: tool.blockIndex,
      content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
    }));
    stopReason = 'tool_use';
    return tool;
  };

  const emitToolArguments = (tool: NonNullable<ReturnType<typeof tools.get>>, delta: string): void => {
    if (!delta) return;
    tool.argumentsJson += delta;
    safeWrite(res, sseEvent('content_block_delta', {
      type: 'content_block_delta', index: tool.blockIndex,
      delta: { type: 'input_json_delta', partial_json: delta },
    }));
  };

  const closeTool = (tool: NonNullable<ReturnType<typeof tools.get>>): void => {
    if (tool.closed) return;
    tool.closed = true;
    safeWrite(res, sseEvent('content_block_stop', {
      type: 'content_block_stop', index: tool.blockIndex,
    }));
  };

  const itemText = (item: any): string => {
    if (!item) return '';
    if (typeof item.text === 'string') return item.text;
    if (!Array.isArray(item.content)) return '';
    return item.content.map((part: any) => typeof part === 'string' ? part : part?.text || '').join('');
  };

  const completeOutputItem = (outputIndex: number, item: any): void => {
    if (item?.type === 'function_call') {
      const tool = openTool(outputIndex, item)!;
      const finalArguments = typeof item.arguments === 'string'
        ? item.arguments : JSON.stringify(item.arguments ?? {});
      if (finalArguments && finalArguments !== tool.argumentsJson) {
        emitToolArguments(tool, finalArguments.startsWith(tool.argumentsJson)
          ? finalArguments.slice(tool.argumentsJson.length) : finalArguments);
      }
      closeTool(tool);
      return;
    }
    if (item?.type === 'message' || item?.role === 'assistant') {
      const finalText = itemText(item);
      if (finalText && finalText !== streamedText) {
        emitText(finalText.startsWith(streamedText) ? finalText.slice(streamedText.length) : finalText);
      }
    }
  };

  const finish = (response: any): void => {
    if (completed) return;
    completed = true;
    if (response) {
      // Besides mapping usage, this preserves encrypted reasoning/function-call
      // items for the next Claude tool-result turn.
      convertResponsesToAnthropic(response);
      const usage = response.usage;
      outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
      if (response.status === 'incomplete') stopReason = 'max_tokens';
      if (Array.isArray(response.output)) {
        response.output.forEach((item: any, index: number) => completeOutputItem(index, item));
      }
    }
    if (textBlockIndex !== null) {
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop', index: textBlockIndex,
      }));
    }
    for (const tool of tools.values()) closeTool(tool);
    safeWrite(res, sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }));
    safeWrite(res, sseEvent('message_stop', { type: 'message_stop' }));
    safeEnd(res);
  };

  const processEvent = (event: any): void => {
    const type = event?.type;
    if (type === 'response.output_text.delta') {
      emitText(event.delta || '');
    } else if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      openTool(event.output_index ?? 0, event.item);
    } else if (type === 'response.function_call_arguments.delta') {
      const tool = openTool(event.output_index ?? 0, event.item || {})!;
      emitToolArguments(tool, event.delta || '');
    } else if (type === 'response.output_item.done') {
      completeOutputItem(event.output_index ?? 0, event.item);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      finish(event.response);
    } else if (type === 'response.failed' || type === 'error') {
      const message = event.response?.error?.message || event.error?.message || event.message || 'Azure Responses stream failed';
      throw new Error(message);
    }
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        processEvent(JSON.parse(data));
      }
    }
    if (!completed) finish(null);
  } catch (err) {
    getLogger().error({ err: errInfo(err), providerModel }, 'responses_stream_error');
    if (!res.writableEnded) {
      safeWrite(res, sseEvent('error', {
        type: 'error',
        error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) },
      }));
      safeEnd(res);
    }
  } finally {
    reader.releaseLock();
  }
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
  const activePid = state.providerManager.getActive()?.id ?? 'env-default';
  const cbKey = `${activePid}:${providerModel}`;

  // ── Idle-chunk timeout setup ──────────────────────────────────────────────
  const IDLE_TIMEOUT_MS = cfg.idleTimeoutMs;
  const KEEP_ALIVE_PING_MS = cfg.keepAlivePingMs;

  let currentAbortController = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleTriggered = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let headersWritten = false;
  let messageStartSent = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let textBlockOpen = false;
  let textBlockIndex = -1;
  let activeToolBlockIndex: number | null = null;
  let activeToolIdx: number | null = null;
  let nextBlockIndex = 0;

  const onClientClose = () => {
    currentAbortController.abort();
    if (activeReader) {
      try {
        activeReader.cancel().catch(() => {});
      } catch {
        // ignore
      }
    }
  };
  _req.on('close', onClientClose);
  res.on('close', onClientClose);

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTriggered = true;
      logger.warn({ idleTimeoutMs: IDLE_TIMEOUT_MS, providerModel }, 'stream_idle_timeout');
      currentAbortController.abort();
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
    if (currentAbortController.signal.aborted) {
      currentAbortController = new AbortController();
    }
    const result = await service.createChatCompletionStream(
      { ...streamBody, model, stream: true },
      isBackup ? null : backupModel,
      currentAbortController.signal,
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
    const toolCalls = choice?.message?.tool_calls;
    let finishReason = mapFinishReason(choice?.finish_reason ?? null);
    if (toolCalls && toolCalls.length > 0 && finishReason !== 'max_tokens') {
      finishReason = 'tool_use';
    }
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

    if (!messageStartSent) {
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
      messageStartSent = true;
    }

    if (textBlockOpen) {
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop', index: textBlockIndex,
      } satisfies AnthropicStreamEvent));
      textBlockOpen = false;
    }
    if (activeToolBlockIndex !== null) {
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop', index: activeToolBlockIndex,
      } satisfies AnthropicStreamEvent));
      activeToolBlockIndex = null;
      activeToolIdx = null;
    }

    let fallbackBlockIdx = nextBlockIndex;
    if (content) {
      safeWrite(res, sseEvent('content_block_start', {
        type: 'content_block_start', index: fallbackBlockIdx,
        content_block: { type: 'text', text: '' },
      } satisfies AnthropicStreamEvent));
      safeWrite(res, sseEvent('content_block_delta', {
        type: 'content_block_delta', index: fallbackBlockIdx,
        delta: { type: 'text_delta', text: content },
      } satisfies AnthropicStreamEvent));
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop', index: fallbackBlockIdx,
      } satisfies AnthropicStreamEvent));
      fallbackBlockIdx++;
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        safeWrite(res, sseEvent('content_block_start', {
          type: 'content_block_start', index: fallbackBlockIdx,
          content_block: {
            type: 'tool_use',
            id: tc.id || `tool_${fallbackBlockIdx}`,
            name: tc.function?.name || 'unknown_tool',
            input: {},
          },
        } satisfies AnthropicStreamEvent));
        if (tc.function?.arguments) {
          safeWrite(res, sseEvent('content_block_delta', {
            type: 'content_block_delta', index: fallbackBlockIdx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          } satisfies AnthropicStreamEvent));
        }
        safeWrite(res, sseEvent('content_block_stop', {
          type: 'content_block_stop', index: fallbackBlockIdx,
        } satisfies AnthropicStreamEvent));
        fallbackBlockIdx++;
      }
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
  let altStreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const streamResult = await openStream(providerModel, false);

  if (!streamResult.ok) {
    const errBody = streamResult.body as { error?: { message?: string; type?: string } };
    const message = errBody?.error?.message ?? 'Upstream stream request failed';

    // ── Cross-provider failover (before non-stream fallback) ──────────────
    const STREAM_FAILOVER_STATUSES = new Set([401, 404, 429, 500, 502, 503, 504, 529]);
    let allFailoversExhausted = false;
    if (STREAM_FAILOVER_STATUSES.has(streamResult.status) && !headersWritten) {
      const failoverCfg = state.failoverEngine.getConfig();
      if (failoverCfg.failover_enabled) {
        const activePid = state.providerManager.getActive()?.id ?? 'env-default';
        const alternates = state.failoverEngine.getAlternateProviders(activePid);
        const switchStart = Date.now();
        for (const altProv of alternates) {
          let baseUrl = altProv.baseUrl;
          if (altProv.type === 'aws_bedrock' && altProv.awsRegion) {
            baseUrl = getBedrockBaseUrl(altProv.awsRegion);
          }
          const altOpts: { baseUrl?: string; apiKey?: string; urlSuffix?: string } = {
            baseUrl,
            apiKey: altProv.apiKey,
          };
          if (altProv.type === 'azure_foundry') {
            altOpts.urlSuffix = `?api-version=${altProv.azureApiVersion || '2024-05-01-preview'}`;
          }
          const altSvc = new BluesmindsService(altOpts);
          if (currentAbortController.signal.aborted) {
            currentAbortController = new AbortController();
          }

          // Bound alternate probe to 10s timeout so we never hang for minutes
          const probeController = new AbortController();
          const probeTimeout = setTimeout(() => probeController.abort(), 10_000);
          const combinedSignal = AbortSignal.any
            ? AbortSignal.any([probeController.signal, currentAbortController.signal])
            : probeController.signal;

          let altRes: Awaited<ReturnType<typeof altSvc.createChatCompletionStreamOnce>>;
          try {
            altRes = await altSvc.createChatCompletionStreamOnce(
              { ...streamBody, model: altProv.defaultModel, stream: true },
              combinedSignal,
            );
          } catch {
            altRes = { ok: false, status: 504, body: { error: { message: 'Alternate stream connect timeout' } } };
          } finally {
            clearTimeout(probeTimeout);
          }

          if (altRes.ok && altRes.response.body) {
            altStreamReader = altRes.response.body.getReader();
            activeReader = altStreamReader;
            logger.warn(
              { fromModel: providerModel, toProvider: altProv.id, toModel: altProv.defaultModel, triggerStatus: streamResult.status },
              'stream_provider_failover',
            );
            try {
              state.failoverEngine.logSwitchEvent({
                fromProviderId: activePid, fromModel: providerModel,
                toProviderId: altProv.id, toModel: altProv.defaultModel,
                reason: streamResult.status === 429 ? '429_rate_limit' : `${streamResult.status}_error`,
                responseTimeMs: Date.now() - switchStart,
                requestId: _req.headers['x-request-id'] as string | undefined,
              });

              if (activePid !== 'env-default') {
                state.failoverEngine.markProviderStatus(activePid, streamResult.status === 429 ? 'RATE_LIMITED' : streamResult.status === 401 ? 'AUTH_ERROR' : 'UNREACHABLE', `Failover triggered (${streamResult.status})`);
              }
              state.failoverEngine.markProviderStatus(altProv.id, 'HEALTHY', '');
              
              if (activePid && activePid !== 'env-default') {
                const currentSnap = state.modelRegistry.snapshot();
                state.providerManager.saveModelSnapshot(
                  activePid,
                  currentSnap.mappings,
                  currentSnap.familyRules,
                  currentSnap.default,
                );
              }

              state.providerManager.setActive(altProv.id);
              const savedSnap = state.providerManager.getModelSnapshot(altProv.id);
              if (savedSnap) {
                if (Object.keys(savedSnap.mappings).length > 0) {
                  state.modelRegistry.replace({ mappings: savedSnap.mappings, default: savedSnap.defaultModel || altProv.defaultModel });
                } else {
                  state.modelRegistry.setDefault(savedSnap.defaultModel || altProv.defaultModel);
                }
                if (savedSnap.familyRules.length > 0) {
                  state.modelRegistry.replaceFamilyRules(savedSnap.familyRules);
                }
                state.configManager.update({ defaultModel: savedSnap.defaultModel || altProv.defaultModel });
              } else if (altProv.defaultModel) {
                state.modelRegistry.setDefault(altProv.defaultModel);
                state.configManager.update({ defaultModel: altProv.defaultModel });
              }
              logger.info({ fromProviderId: activePid, toProviderId: altProv.id }, 'auto_promoted_failover_provider');
            } catch (err) { 
              logger.error(err, 'Failed to log or auto-promote alternate provider'); 
            }
            break;
          } else {
            // Mark this alternate as failed so it gets cooled down.
            // `altRes` may be ok:true-with-empty-body here, so read status defensively.
            const altStatus = 'status' in altRes ? altRes.status : 0;
            const failStatus = altStatus === 401 || altStatus === 403 ? 'AUTH_ERROR' : 'RATE_LIMITED';
            state.failoverEngine.markProviderStatus(
              altProv.id,
              failStatus,
              `Stream failover attempt returned ${altStatus}`
            );
          }
        }
        
        if (altStreamReader === null && alternates.length > 0) {
           allFailoversExhausted = true;
        }
      }
    }
    // ── End cross-provider failover ───────────────────────────────────────

    if (altStreamReader === null) {
      if (allFailoversExhausted) {
         const errMsg = `All alternate providers failed or are rate limited. Primary provider returned ${streamResult.status}.`;
         if (!headersWritten) {
            res.status(529).json({
               type: 'error',
               error: { type: 'overloaded_error', message: errMsg }
            });
         } else if (!res.writableEnded) {
            safeWrite(res, sseEvent('error', { type: 'error', error: { type: 'overloaded_error', message: errMsg } }));
            safeEnd(res);
         }
         state.requestLog.record({
            endpoint: _req.originalUrl || _req.url,
            method: _req.method,
            clientModel: originalClientModel,
            resolvedModel: providerModel,
            status: 529,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - startTime,
            streaming: true,
            error: errMsg,
         });
         return;
      }

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
    // altStreamReader is set — fall through to the stream reading loop below
  }

  // Use the alt stream (cross-provider failover) or the primary stream
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let cascaded: boolean;
  if (altStreamReader !== null) {
    reader = altStreamReader;
    cascaded = true;
  } else {
    const ok = streamResult as { ok: true; reader: ReadableStreamDefaultReader<Uint8Array>; cascaded: boolean };
    reader = ok.reader;
    cascaded = ok.cascaded;
    
    // Auto-recover health status on successful primary request
    const activePid = state.providerManager.getActive()?.id ?? 'env-default';
    state.failoverEngine.markProviderStatus(activePid, 'HEALTHY', '');
  }
  activeReader = reader;

  // ── SSE headers ───────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  headersWritten = true;

  const messageId = `msg_${Date.now()}`;

  if (!messageStartSent) {
    safeWrite(res, sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: cascaded && backupModel ? backupModel : providerModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } satisfies AnthropicStreamEvent));

    safeWrite(res, sseEvent('ping', { type: 'ping' } satisfies AnthropicStreamEvent));
    messageStartSent = true;
  }

  let stopReason = 'end_turn';
  let buffer = '';
  let fallbackUsed: 'non_stream' | undefined;

  const toolAccums = new Map<number, { blockIndex: number; accum: ToolCallAccum; started: boolean }>();

  function closeOpenTextBlock(): void {
    if (textBlockOpen) {
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: textBlockIndex,
      } satisfies AnthropicStreamEvent));
      textBlockOpen = false;
    }
  }

  function closeActiveToolBlock(): void {
    if (activeToolBlockIndex !== null) {
      safeWrite(res, sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: activeToolBlockIndex,
      } satisfies AnthropicStreamEvent));
      activeToolBlockIndex = null;
      activeToolIdx = null;
    }
  }

  function openTextBlock(): void {
    if (textBlockOpen) return;
    closeActiveToolBlock();
    textBlockOpen = true;
    textBlockIndex = nextBlockIndex++;
    safeWrite(res, sseEvent('content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' },
    } satisfies AnthropicStreamEvent));
  }

  function processChunk(chunk: OpenAIStreamChunk): void {
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage) {
        if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
      }
      return;
    }

    const delta = choice.delta;

    // ── Text delta ──────────────────────────────────────────────
    if (delta?.content) {
      // If tools have already started/accumulated and this delta is just whitespace, ignore it
      if (toolAccums.size > 0 && !delta.content.trim()) {
        // Drop trailing whitespace from upstream after tool calls
      } else {
        openTextBlock();
        safeWrite(res, sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        } satisfies AnthropicStreamEvent));
        outputTokens++;
      }
    }

    // ── Tool call deltas ────────────────────────────────────────
    if (delta?.tool_calls) {
      closeOpenTextBlock();

      for (const tcDelta of delta.tool_calls) {
        const idx = tcDelta.index ?? 0;

        if (!toolAccums.has(idx)) {
          if (activeToolBlockIndex !== null && activeToolIdx !== idx) {
            closeActiveToolBlock();
          }
          const blockIndex = nextBlockIndex++;
          const accum: ToolCallAccum = {
            id: tcDelta.id || `tool_${Date.now()}_${idx}`,
            name: '',
            argumentsJson: '',
          };
          toolAccums.set(idx, { blockIndex, accum, started: false });
        }

        const entry = toolAccums.get(idx)!;
        if (tcDelta.id) entry.accum.id = tcDelta.id;
        if (tcDelta.function?.name) entry.accum.name += tcDelta.function.name;

        if (!entry.started && (entry.accum.name || tcDelta.function?.arguments)) {
          if (activeToolBlockIndex !== null && activeToolIdx !== idx) {
            closeActiveToolBlock();
          }
          safeWrite(res, sseEvent('content_block_start', {
            type: 'content_block_start',
            index: entry.blockIndex,
            content_block: {
              type: 'tool_use',
              id: entry.accum.id,
              name: entry.accum.name || 'tool',
              input: {},
            },
          }));
          entry.started = true;
          activeToolBlockIndex = entry.blockIndex;
          activeToolIdx = idx;
        }

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

  // ── Stream reader loop ────────────────────────────────────────────────────
  const decoder = new TextDecoder();

  // Start idle timer + keep-alive pings
  resetIdleTimer();
  startKeepAlive();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Got a chunk — stream is alive, reset idle timer
      resetIdleTimer();

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

        processChunk(chunk);
      }
    }

    // Stream completed successfully — record circuit success
    cb.recordSuccess(providerModel);

  } catch (err) {
    clearIdleTimer();
    stopKeepAlive();

    const isIdleAbort = idleTriggered || currentAbortController.signal.aborted;
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
    if (isIdleAbort && backupModel && !cascaded && outputTokens === 0) {
      logger.warn({ primaryModel: providerModel, backupModel, outputTokensSoFar: outputTokens }, 'stream_idle_cascade_to_backup');

      idleTriggered = false;
      if (currentAbortController.signal.aborted) {
        currentAbortController = new AbortController();
      }
      const backupResult = await openStream(backupModel, true);

      if (backupResult.ok) {
        cascaded = true;
        reader = backupResult.reader;
        activeReader = reader;
        buffer = '';
        resetIdleTimer();
        startKeepAlive();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdleTimer();

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
              processChunk(chunk);
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
    _req.off('close', onClientClose);
    res.off('close', onClientClose);
  }

  // ── Close SSE stream ──────────────────────────────────────────────────────
  if (res.writableEnded) return; // already closed by fallback path

  closeOpenTextBlock();
  closeActiveToolBlock();

  if (toolAccums.size > 0 && stopReason !== 'max_tokens') {
    stopReason = 'tool_use';
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

  const messagesHandler = async (req: Request, res: Response) => {
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

      // ── Auto-Compact: process messages through context tracker ──────────────
      // This checks token usage, triggers compaction if needed, and injects
      // session context from previous compactions. Operates on the converted
      // OpenAI message array.
      let processedRequest = conversion.request;
      try {
        const summarizerConfig = {
          baseUrl: state.configManager.getBaseUrl(),
          apiKey: state.configManager.getApiKey(),
          model: providerModel,
          timeoutMs: Math.min(30000, state.configManager.getRequestTimeoutMs()),
        };
        const { messages: compactedMessages, compactionResult } =
          await state.contextTracker.process(
            conversion.request.messages,
            providerModel,
            summarizerConfig,
          );
        processedRequest = { ...conversion.request, messages: compactedMessages };
        if (compactionResult) {
          logger.info(
            {
              sessionId: compactionResult.sessionId,
              level: compactionResult.level,
              tokensSaved: compactionResult.tokensSaved,
              tokensAfter: compactionResult.tokensAfterCompaction,
            },
            'auto_compact_applied',
          );
        }
      } catch (compactErr) {
        // Context tracking is best-effort — never block a request due to compaction errors
        logger.warn(
          { err: compactErr instanceof Error ? compactErr.message : String(compactErr) },
          'auto_compact_skipped_on_error',
        );
      }
      // ── End Auto-Compact ───────────────────────────────────────────────────

      // ── Configure Active Service by Provider Type ─────────────────────────────
      let activeService = service;
      const activeProvider = state.providerManager.getActive();
      if (activeProvider?.type === 'aws_bedrock') {
        const bedrockBaseUrl = getBedrockBaseUrl(activeProvider.awsRegion || '');
        activeService = new BluesmindsService({
          baseUrl: bedrockBaseUrl,
          apiKey: activeProvider.apiKey,
        });
      } else if (activeProvider?.type === 'azure_foundry') {
        let azureBase = activeProvider.baseUrl.replace(/\/+$/, '');
        let urlSuffix = `?api-version=${activeProvider.azureApiVersion || '2024-05-01-preview'}`;
        if (activeProvider.azureApiFlavor === 'responses') {
          if (!azureBase.includes('/openai') && !azureBase.includes('/v1') && !azureBase.includes('/models')) {
            azureBase = `${azureBase}/openai/v1`;
          }
          // OpenAI v1 compatible routes (/openai/v1/responses) do not take ?api-version=
          urlSuffix = '';
        }
        activeService = new BluesmindsService({
          baseUrl: azureBase,
          apiKey: activeProvider.apiKey,
          urlSuffix,
        });
      }

      const isResponsesFlavor = activeProvider?.azureApiFlavor === 'responses';

      // ── Handle Responses API Flavor ───────────────────────────────────────────
      if (isResponsesFlavor) {
        const clientWantsStream = (req.body as { stream?: boolean }).stream === true;
        const responsesBody = convertAnthropicToResponsesRequest(req.body, providerModel);

        if (clientWantsStream) {
          res.locals = { ...(res.locals ?? {}), __skipLogCapture: true };
          await handleResponsesStreaming(res, activeService, responsesBody, providerModel);
          return;
        }

        // Azure can take several minutes on larger coding turns. Stream it
        // upstream even when the Claude client requested a JSON response, then
        // aggregate the terminal Responses event below.
        const upstream = await collectResponsesCompletion(activeService, responsesBody);
        if (!upstream.ok) {
          const mapped = mapOpenAIErrorToAnthropic({
            status: upstream.status,
            body: upstream.body as unknown as OpenAIErrorBody,
          });
          res.status(mapped.status).json(mapped.body);
          return;
        }

        const openAiFormat = convertResponsesToAnthropic(upstream.body);
        const anthropicResponse = convertOpenAIResponseToAnthropic(
          openAiFormat as OpenAIChatCompletionsResponse,
          providerModel,
        );
        res.status(200).json(anthropicResponse);
        return;
      }
      // ──────────────────────────────────────────────────────────────────────────

      const wantsStream = (req.body as { stream?: boolean }).stream === true;
      if (wantsStream) {
        res.locals = { ...(res.locals ?? {}), __skipLogCapture: true };
        await handleStreaming(req, res, activeService, providerModel, originalClientModel, processedRequest, state, backupModel);
        return;
      }

      // Non-streaming path
      const openaiRequest = { ...processedRequest, model: providerModel, stream: false };
      const upstream = await state.failoverEngine.executeWithFailover(
        () => activeService.createChatCompletion(openaiRequest, backupModel),
        (altProv) => {
          let baseUrl = altProv.baseUrl;
          if (altProv.type === 'aws_bedrock' && altProv.awsRegion) {
            baseUrl = getBedrockBaseUrl(altProv.awsRegion);
          }
          const altOpts: { baseUrl?: string; apiKey?: string; urlSuffix?: string } = {
            baseUrl,
            apiKey: altProv.apiKey,
          };
          if (altProv.type === 'azure_foundry') {
            altOpts.urlSuffix = `?api-version=${altProv.azureApiVersion || '2024-05-01-preview'}`;
          }
          return new BluesmindsService(altOpts).createChatCompletion({ ...openaiRequest, model: altProv.defaultModel }, null);
        },
        {
          providerId: state.providerManager.getActive()?.id ?? 'env-default',
          modelId: providerModel,
          requestId: req.headers['x-request-id'] as string | undefined,
        },
      );

      if (!upstream.ok) {
        const mapped = mapOpenAIErrorToAnthropic({
          status: upstream.status,
          body: upstream.body as unknown as OpenAIErrorBody,
        });
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
  };

  const countTokensHandler = (req: Request, res: Response): void => {
    const body = req.body ?? {};
    let charCount = 0;
    if (typeof body.system === 'string') {
      charCount += body.system.length;
    } else if (Array.isArray(body.system)) {
      for (const b of body.system) {
        if (typeof b?.text === 'string') charCount += b.text.length;
      }
    }
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (typeof msg?.content === 'string') {
          charCount += msg.content.length;
        } else if (Array.isArray(msg?.content)) {
          for (const part of msg.content) {
            if (typeof part?.text === 'string') charCount += part.text.length;
          }
        }
      }
    }
    const input_tokens = Math.max(1, Math.ceil(charCount / 3.8));
    res.status(200).json({ input_tokens });
  };

  router.post('/v1/messages', messagesHandler);
  router.post('/messages', messagesHandler);
  router.post('/v1/v1/messages', messagesHandler);

  router.post('/v1/messages/count_tokens', countTokensHandler);
  router.post('/messages/count_tokens', countTokensHandler);
  router.post('/v1/v1/messages/count_tokens', countTokensHandler);

  return router;
}
