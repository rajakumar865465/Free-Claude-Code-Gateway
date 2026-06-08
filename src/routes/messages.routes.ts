import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service';
import { anthropicError, mapOpenAIErrorToAnthropic } from '../converters/errors';
import { convertOpenAIResponseToAnthropic } from '../converters/openai-to-anthropic';
import { validateAndConvertAnthropicRequest } from '../converters/anthropic-to-openai';
import { getLogger } from '../utils/logger';
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

// Accumulator for a streaming tool call being assembled across deltas
interface ToolCallAccum {
  id: string;
  name: string;
  argumentsJson: string;
}

async function handleStreaming(
  _req: Request,
  res: Response,
  service: BluesmindsService,
  providerModel: string,
  originalClientModel: string,
  streamBody: OpenAIChatCompletionsRequest,
  state: AdminState,
): Promise<void> {
  const logger = getLogger();
  const startTime = _req.startTime ?? Date.now();
  let inputTokens = 0;
  let errorMsg: string | undefined;

  const upstream = await service.createChatCompletionStream({
    ...streamBody,
    model: providerModel,
    stream: true,
  });

  if (!upstream.ok) {
    const errBody = upstream.body as { error?: { message?: string; type?: string } };
    const message = errBody?.error?.message ?? 'Upstream stream request failed';
    const mapped = mapOpenAIErrorToAnthropic({
      status: upstream.status,
      body: { error: { message, type: errBody?.error?.type } },
    });
    res.status(mapped.status).json(mapped.body);
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

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const messageId = `msg_${Date.now()}`;

  res.write(sseEvent('message_start', {
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

  res.write(sseEvent('ping', { type: 'ping' } satisfies AnthropicStreamEvent));

  let outputTokens = 0;
  let stopReason = 'end_turn';
  let buffer = '';

  // Track open content blocks
  let textBlockOpen = false;
  let textBlockIndex = -1;
  // Map from OpenAI tool call index → { anthropic block index, accum }
  const toolAccums = new Map<number, { blockIndex: number; accum: ToolCallAccum }>();
  let nextBlockIndex = 0;

  function openTextBlock(): void {
    if (textBlockOpen) return;
    textBlockOpen = true;
    textBlockIndex = nextBlockIndex++;
    res.write(sseEvent('content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' },
    } satisfies AnthropicStreamEvent));
  }

  // Retrieve the abort controller stored by streamOnce so we can clear its
  // timer after we finish reading — prevents the timeout from firing mid-stream.
  const streamController = (upstream.response as unknown as {
    __abortController?: { clear(): void };
  }).__abortController;

  try {
    const body = upstream.response.body;
    if (!body) throw new Error('No response body from upstream');

    const reader = body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
          // Usage-only chunk (no choices) — capture token counts
          if (chunk.usage) {
            if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
            if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
          }
          continue;
        }

        const delta = choice.delta;

        // ── Text delta ────────────────────────────────────────────────
        if (delta?.content) {
          openTextBlock();
          res.write(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: delta.content },
          } satisfies AnthropicStreamEvent));
          outputTokens++;
        }

        // ── Tool call deltas ──────────────────────────────────────────
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
              res.write(sseEvent('content_block_start', {
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
              res.write(sseEvent('content_block_delta', {
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

        // Capture token usage when present on a choices chunk
        if (chunk.usage) {
          if (chunk.usage.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
          if (chunk.usage.completion_tokens) outputTokens = chunk.usage.completion_tokens;
        }
      }
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : 'Stream read failed';
    logger.error({ err }, 'stream_read_error');
    res.write(sseEvent('error', {
      type: 'error',
      error: { type: 'api_error', message: errorMsg },
    } satisfies AnthropicStreamEvent));
    res.end();

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
  } finally {
    // Clear the upstream abort controller timer now that we are done reading
    streamController?.clear();
  }

  // Close text block
  if (textBlockOpen) {
    res.write(sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: textBlockIndex,
    } satisfies AnthropicStreamEvent));
  }

  // Close tool use blocks
  for (const [, entry] of toolAccums) {
    res.write(sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: entry.blockIndex,
    } satisfies AnthropicStreamEvent));
  }

  res.write(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } satisfies AnthropicStreamEvent));

  res.write(sseEvent('message_stop', { type: 'message_stop' } satisfies AnthropicStreamEvent));

  res.end();

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
    error: errorMsg,
  });
}

export function buildMessagesRouter(service: BluesmindsService, state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  router.post('/v1/messages', async (req: Request, res: Response) => {
    const conversion = validateAndConvertAnthropicRequest(req.body);
    if (!conversion.ok) {
      res.status(conversion.status).json(conversion.body);
      return;
    }

    // Capture the original client-side model name before resolution so logs
    // correctly show what the client requested vs what was sent upstream.
    const clientModel = (req.body as { model?: unknown })?.model;
    const originalClientModel = typeof clientModel === 'string' ? clientModel : '';

    let providerModel: string;
    try {
      providerModel = state.modelRegistry.resolve(
        conversion.request.model || undefined,
        state.configManager.getDefaultModel(),
        state.configManager.isStrictMapping(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Model resolution failed.';
      res.status(400).json(anthropicError('invalid_request_error', message, 400).body);
      return;
    }

    res.locals = { ...(res.locals ?? {}), providerModel };

    // Streaming path — log is recorded directly inside handleStreaming
    const wantsStream = (req.body as { stream?: boolean }).stream === true;
    if (wantsStream) {
      // Tell the request-log middleware to skip its own logging for this response;
      // handleStreaming records the entry itself with accurate token counts.
      res.locals = { ...(res.locals ?? {}), __skipLogCapture: true };
      // Pass originalClientModel so the log entry correctly records the client's model name
      await handleStreaming(req, res, service, providerModel, originalClientModel, conversion.request, state);
      return;
    }

    // Non-streaming path
    const openaiRequest = { ...conversion.request, model: providerModel, stream: false };
    const upstream = await service.createChatCompletion(openaiRequest);

    if (!upstream.ok) {
      const mapped = mapOpenAIErrorToAnthropic(upstream.body as OpenAIErrorResponse);
      if (mapped.body.error.type === 'timeout_error') {
        logger.warn({ providerModel, status: mapped.status }, 'upstream_timeout');
      } else if (mapped.body.error.type === 'permission_error') {
        logger.warn({ providerModel, status: mapped.status }, 'tier_restriction');
      } else {
        logger.warn({ providerModel, status: mapped.status, type: mapped.body.error.type }, 'upstream_error');
      }
      res.status(mapped.status).json(mapped.body);
      return;
    }

    const anthropicResponse = convertOpenAIResponseToAnthropic(
      upstream.body as OpenAIChatCompletionsResponse,
      providerModel,
    );

    res.status(200).json(anthropicResponse);
  });

  return router;
}
