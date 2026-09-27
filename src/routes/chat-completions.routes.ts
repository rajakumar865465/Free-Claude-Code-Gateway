import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service'; // kept for alt-call construction
import { anthropicError } from '../converters/errors';
import { getLogger } from '../utils/logger';
import type { OpenAIChatCompletionsRequest, OpenAIErrorBody } from '../types/openai';
import type { AdminState } from '../admin/admin-state';
import { getBedrockBaseUrl } from '../utils/bedrock-url';

export function buildChatCompletionsRouter(service: BluesmindsService, _state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  const chatCompletionsHandler = async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<OpenAIChatCompletionsRequest> & Record<string, unknown>;

    if (!body.model || typeof body.model !== 'string') {
      res.status(400).json({
        error: {
          message: 'model is required.',
          type: 'invalid_request_error',
          param: 'model',
          code: null,
        },
      });
      return;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: 'messages must be a non-empty array.',
          type: 'invalid_request_error',
          param: 'messages',
          code: null,
        },
      });
      return;
    }

    res.locals = { ...(res.locals ?? {}), providerModel: body.model };

    // ── Auto-Compact: track context usage for this session ────────────────────
    let processedMessages = body.messages as OpenAIChatCompletionsRequest['messages'];
    try {
      const summarizerConfig = {
        baseUrl: _state.configManager.getBaseUrl(),
        apiKey: _state.configManager.getApiKey(),
        model: body.model,
        timeoutMs: 30000,
      };
      const { messages: compacted } = await _state.contextTracker.process(
        body.messages as OpenAIChatCompletionsRequest['messages'],
        body.model,
        summarizerConfig,
      );
      processedMessages = compacted;
    } catch {
      // Best-effort — never block request
    }
    // ── End Auto-Compact ───────────────────────────────────────────────────

    // ── AWS Bedrock routing ───────────────────────────────────────────────────
    const activeProvider = _state.providerManager.getActive();
    if (activeProvider?.type === 'aws_bedrock') {
      try {
        // Construct Bedrock OpenAI-compatible base URL from region
        const bedrockBaseUrl = getBedrockBaseUrl(activeProvider.awsRegion || '');
        
        // Create service with Bedrock endpoint and API key
        const bedrockService = new BluesmindsService({
          baseUrl: bedrockBaseUrl,
          apiKey: activeProvider.apiKey,
        });

        const requestBody = {
          ...(body as OpenAIChatCompletionsRequest),
          messages: processedMessages,
        };

        if (body.stream === true) {
          // Streaming response
          const streamResponse = await bedrockService.createChatCompletionStream(requestBody);
          
          if (!streamResponse.ok) {
            const errBody = streamResponse.body as { error?: { message?: string; type?: string } } | null;
            const message = errBody?.error?.message ?? 'AWS Bedrock stream request failed';
            res.status(streamResponse.status).json({
              error: {
                message,
                type: 'api_error',
                param: null,
                code: null,
              },
            });
            return;
          }

          // Pipe the stream directly to the response
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          try {
            const reader = streamResponse.response.body?.getReader();
            if (!reader) throw new Error('No response body from Bedrock');
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(decoder.decode(value, { stream: true }));
            }
          } catch (err) {
            logger.error({ err }, 'bedrock_stream_read_error');
          }
          res.end();
          return;
        } else {
          // Non-streaming response
          const result = await bedrockService.createChatCompletion(requestBody);
          
          if (!result.ok) {
            const errBody = result.body as { error?: { message?: string; type?: string } } | null;
            const message = errBody?.error?.message ?? 'AWS Bedrock request failed';
            res.status(result.status).json({
              error: {
                message,
                type: 'api_error',
                param: null,
                code: null,
              },
            });
            return;
          }
          
          res.json(result.body);
          return;
        }
      } catch (error: any) {
        logger.error({ error: error.message }, 'bedrock_request_error');
        res.status(500).json({
          error: {
            message: error.message || 'AWS Bedrock request failed',
            type: 'api_error',
            param: null,
            code: null,
          },
        });
        return;
      }
    }
    let activeService = service;
    if (activeProvider?.type === 'azure_foundry') {
      activeService = new BluesmindsService({
        baseUrl: activeProvider.baseUrl,
        apiKey: activeProvider.apiKey,
        urlSuffix: `?api-version=${activeProvider.azureApiVersion || '2024-05-01-preview'}`,
      });
    }

    // ── Streaming path ────────────────────────────────────────────────────────
    if (body.stream === true) {
      const streamController = new AbortController();
      const idleTimeoutMs = 60_000;
      let idleTimer: NodeJS.Timeout | null = null;

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logger.warn({ providerModel: body.model, idleTimeoutMs }, 'openai_stream_idle_timeout');
          streamController.abort();
        }, idleTimeoutMs);
      };

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const onClientClose = () => {
        clearIdleTimer();
        streamController.abort();
      };
      req.on('close', onClientClose);
      res.on('close', onClientClose);

      const upstream = await activeService.createChatCompletionStream(
        {
          ...(body as OpenAIChatCompletionsRequest),
          messages: processedMessages,
          stream: true,
        },
        null,
        streamController.signal,
      );

      if (!upstream.ok) {
        clearIdleTimer();
        req.off('close', onClientClose);
        res.off('close', onClientClose);
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

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        reader = upstream.response.body?.getReader();
        if (!reader) throw new Error('No response body from upstream');
        const decoder = new TextDecoder();
        resetIdleTimer();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdleTimer();
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        logger.error({ err }, 'openai_stream_read_error');
      } finally {
        clearIdleTimer();
        req.off('close', onClientClose);
        res.off('close', onClientClose);
        try { reader?.cancel(); } catch { /* ignore */ }
      }
      res.end();
      return;
    }

    // ── Non-streaming path ────────────────────────────────────────────────────
    const nonStreamBody = {
      ...(body as OpenAIChatCompletionsRequest),
      messages: processedMessages,
      stream: false as const,
    };
    const upstream = await _state.failoverEngine.executeWithFailover(
      () => activeService.createChatCompletion(nonStreamBody),
      (altProv) => {
        const altOpts: { baseUrl?: string; apiKey?: string; urlSuffix?: string } = {
          baseUrl: altProv.baseUrl,
          apiKey: altProv.apiKey,
        };
        if (altProv.type === 'azure_foundry') {
          altOpts.urlSuffix = `?api-version=${altProv.azureApiVersion || '2024-05-01-preview'}`;
        }
        return new BluesmindsService(altOpts)
          .createChatCompletion({ ...nonStreamBody, model: altProv.defaultModel }, null);
      },
      {
        providerId: _state.providerManager.getActive()?.id ?? 'env-default',
        modelId: nonStreamBody.model,
        requestId: req.headers['x-request-id'] as string | undefined,
      },
    );

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
  };

  router.post('/v1/chat/completions', chatCompletionsHandler);
  router.post('/chat/completions', chatCompletionsHandler);
  router.post('/v1/v1/chat/completions', chatCompletionsHandler);

  return router;
}
