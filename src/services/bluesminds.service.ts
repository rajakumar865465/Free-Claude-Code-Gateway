import type {
  OpenAIChatCompletionsRequest,
  OpenAIChatCompletionsResponse,
  OpenAIModelsResponse,
} from '../types/openai';
import type { OpenAIErrorResponse } from '../types/openai';
import { AbortControllerWithTimeout } from '../utils/timeout';
import { getConfig } from '../config/env';
import { getLogger } from '../utils/logger';
import type { ConfigManager } from '../admin/config-manager';

export interface ProviderResponse<T> {
  ok: boolean;
  status: number;
  body: T;
  rawText?: string;
}

// Statuses worth retrying — NOT 429, that is a rate limit and should fail fast
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504, 529]);
const MAX_RETRIES = 4;
// Backoff delays in ms: 1s, 2s, 4s, 8s
const BACKOFF_MS = [1000, 2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BluesmindsService {
  private readonly configManager?: ConfigManager;
  private readonly _baseUrl?: string;
  private readonly _apiKey?: string;
  private readonly _timeoutMs?: number;

  constructor(
    opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number } | { configManager: ConfigManager },
  ) {
    if (opts && 'configManager' in opts) {
      this.configManager = opts.configManager;
      return;
    }
    const cfg = (opts ?? {}) as { baseUrl?: string; apiKey?: string; timeoutMs?: number };
    this._baseUrl = cfg.baseUrl ? cfg.baseUrl.replace(/\/+$/, '') : undefined;
    this._apiKey = cfg.apiKey;
    this._timeoutMs = cfg.timeoutMs;
  }

  private get baseUrl(): string {
    if (this.configManager) return this.configManager.getBaseUrl().replace(/\/+$/, '');
    return this._baseUrl ?? getConfig().bluesmindsBaseUrl.replace(/\/+$/, '');
  }

  private get apiKey(): string {
    if (this.configManager) return this.configManager.getApiKey();
    return this._apiKey ?? getConfig().bluesmindsApiKey;
  }

  private get timeoutMs(): number {
    if (this.configManager) return this.configManager.getRequestTimeoutMs();
    return this._timeoutMs ?? getConfig().requestTimeoutMs;
  }

  private get authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async requestOnce<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ProviderResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortControllerWithTimeout(this.timeoutMs);
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...this.authHeader,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch { /* keep text */ }

      return { ok: res.ok, status: res.status, body: parsed as T, rawText: text };
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      const errorBody: OpenAIErrorResponse['body'] = {
        error: {
          message: isAbort
            ? `Request aborted after ${Date.now() - start}ms (timeout ${this.timeoutMs}ms)`
            : err instanceof Error ? err.message : String(err),
          type: isAbort ? 'timeout_error' : 'network_error',
        },
      };
      return {
        ok: false,
        status: isAbort ? 504 : 502,
        body: { error: errorBody.error } as unknown as T,
        rawText: errorBody.error.message,
      };
    } finally {
      controller.clear();
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ProviderResponse<T>> {
    const logger = getLogger();
    let attempt = 0;

    while (true) {
      const result = await this.requestOnce<T>(method, path, body);

      // Return immediately on success or non-retryable error
      if (result.ok || !RETRYABLE_STATUSES.has(result.status)) {
        return result;
      }

      // No more retries
      if (attempt >= MAX_RETRIES) {
        return result;
      }

      const delay = BACKOFF_MS[attempt] ?? 8000;
      logger.warn(
        { status: result.status, attempt: attempt + 1, retryInMs: delay },
        'upstream_retrying',
      );
      await sleep(delay);
      attempt++;
    }
  }

  async listModels(): Promise<ProviderResponse<OpenAIModelsResponse | OpenAIErrorResponse>> {
    return this.request<OpenAIModelsResponse>('GET', '/models');
  }

  async createChatCompletion(
    body: OpenAIChatCompletionsRequest,
  ): Promise<ProviderResponse<OpenAIChatCompletionsResponse | OpenAIErrorResponse>> {
    return this.request<OpenAIChatCompletionsResponse>('POST', '/chat/completions', body);
  }

  async createChatCompletionStream(
    body: OpenAIChatCompletionsRequest,
  ): Promise<{ ok: true; response: globalThis.Response } | { ok: false; status: number; body: unknown }> {
    const logger = getLogger();
    let attempt = 0;

    while (true) {
      const result = await this.streamOnce(body);

      if (result.ok || !RETRYABLE_STATUSES.has(result.status)) {
        return result;
      }

      if (attempt >= MAX_RETRIES) {
        return result;
      }

      const delay = BACKOFF_MS[attempt] ?? 8000;
      logger.warn(
        { status: result.status, attempt: attempt + 1, retryInMs: delay },
        'upstream_stream_retrying',
      );
      await sleep(delay);
      attempt++;
    }
  }

  private async streamOnce(
    body: OpenAIChatCompletionsRequest,
  ): Promise<{ ok: true; response: globalThis.Response; status: number } | { ok: false; status: number; body: unknown }> {
    const url = `${this.baseUrl}/chat/completions`;
    const controller = new AbortControllerWithTimeout(this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.authHeader,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        controller.clear();
        return { ok: false, status: res.status, body: parsed };
      }

      // Do NOT clear the controller here — the caller streams the response body
      // and needs the abort signal to remain active. The caller is responsible
      // for clearing the controller once it has finished reading the stream.
      // We store it on the response object so the stream reader can clean it up.
      (res as unknown as { __abortController?: AbortControllerWithTimeout }).__abortController = controller;
      return { ok: true, response: res, status: res.status };
    } catch (err) {
      controller.clear();
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      return {
        ok: false,
        status: isAbort ? 504 : 502,
        body: {
          error: {
            message: isAbort
              ? `Stream timed out after ${this.timeoutMs}ms`
              : err instanceof Error ? err.message : String(err),
            type: isAbort ? 'timeout_error' : 'network_error',
          },
        },
      };
    }
  }
}
