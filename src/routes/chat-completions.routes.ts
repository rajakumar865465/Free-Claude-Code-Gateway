import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service';
import { anthropicError } from '../converters/errors';
import { getLogger } from '../utils/logger';
import type { OpenAIChatCompletionsRequest, OpenAIErrorBody } from '../types/openai';
import type { AdminState } from '../admin/admin-state';

export function buildChatCompletionsRouter(service: BluesmindsService, _state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<OpenAIChatCompletionsRequest> & Record<string, unknown>;

    if (!body.model || typeof body.model !== 'string') {
      res
        .status(400)
        .json(anthropicError('invalid_request_error', 'model is required.', 400).body);
      return;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res
        .status(400)
        .json(anthropicError('invalid_request_error', 'messages must be a non-empty array.', 400).body);
      return;
    }

    res.locals = { ...(res.locals ?? {}), providerModel: body.model };

    // ── Streaming path ────────────────────────────────────────────────────────
    if (body.stream === true) {
      const upstream = await service.createChatCompletionStream({
        ...(body as OpenAIChatCompletionsRequest),
        stream: true,
      });

      if (!upstream.ok) {
        const errBody = upstream.body as { error?: { message?: string; type?: string } } | null;
        const message = errBody?.error?.message ?? 'Upstream stream request failed.';
        logger.warn({ providerModel: body.model, status: upstream.status }, 'openai_stream_error');
        res.status(upstream.status).json({
          error: {
            message,
            type: errBody?.error?.type ?? 'api_error',
            param: null,
            code: null,
          },
        });
        return;
      }

      // Retrieve the stored abort controller so we can clear it after reading
      const streamController = (upstream.response as unknown as {
        __abortController?: { clear(): void };
      }).__abortController;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      try {
        const reader = upstream.response.body?.getReader();
        if (!reader) throw new Error('No response body from upstream');
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        logger.error({ err }, 'openai_stream_read_error');
      } finally {
        streamController?.clear();
      }
      res.end();
      return;
    }

    // ── Non-streaming path ────────────────────────────────────────────────────
    const upstream = await service.createChatCompletion({
      ...(body as OpenAIChatCompletionsRequest),
      stream: false,
    });

    if (!upstream.ok) {
      const errBody = upstream.body as unknown as OpenAIErrorBody | null;
      const message = errBody?.error?.message ?? 'Upstream provider error.';
      logger.warn(
        { providerModel: body.model, status: upstream.status },
        'openai_passthrough_error',
      );
      res.status(upstream.status).json({
        error: {
          message,
          type: errBody?.error?.type ?? 'api_error',
          param: errBody?.error?.param ?? null,
          code: errBody?.error?.code ?? null,
        },
      });
      return;
    }

    res.status(200).json(upstream.body);
  });

  return router;
}
