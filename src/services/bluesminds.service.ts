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
  retryAfterMs?: number;   // populated when upstream sends Retry-After header
  cascadedToBackup?: boolean; // true when request was served by the backup model
}

// Statuses worth retrying.
// 429 — provider rate limit: respect Retry-After header, wait, then retry once.
// 500 — some providers return 500 when a model is temporarily overloaded.
// 503, 529 — standard transient server errors.
//
// 504 is DELIBERATELY NOT retryable here. A 504 means a timeout already fired —
// either the provider's own gateway timed out, or OUR client-side timeout
// (AbortControllerWithTimeout) elapsed. Retrying the identical slow request just
// re-waits the entire timeout budget again, turning one slow request into a
// multi-minute stall (observed: duration_ms ~300000). 504 still triggers a
// cascade to the BACKUP model (a different route), which is the useful action.
//
// NOT 502 — TCP connection drop means the model slug is broken; retrying wastes time.
const RETRYABLE_STATUSES = new Set([429, 503, 529]);
// Statuses that trigger an immediate cascade to the backup model (different route).
// 504/500 are included here — a stalled/erroring primary should switch routes,
// not retry the same one.
const BACKUP_TRIGGER_STATUSES = new Set([429, 500, 503, 504, 529]);
const MAX_RETRIES = 2;
// Fallback backoff when no Retry-After header: 1s, 3s
const BACKOFF_MS = [1000, 3000];
// Hard cap on Retry-After to prevent waiting forever (ms)
const MAX_RETRY_AFTER_MS = 15_000;

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

  /** Timeout for non-stream fallback requests — shorter than the main timeout. */
  private get nonStreamFallbackTimeoutMs(): number {
    return getConfig().nonStreamFallbackTimeoutMs;
  }

  private get authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async requestOnce<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    overrideTimeoutMs?: number,
  ): Promise<ProviderResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortControllerWithTimeout(overrideTimeoutMs ?? this.timeoutMs);
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

      // Read Retry-After header (seconds or HTTP-date) for 429 handling
      let retryAfterMs: number | undefined;
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter) {
          const seconds = Number(retryAfter);
          if (Number.isFinite(seconds) && seconds > 0) {
            retryAfterMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
          }
        }
      }

      return { ok: res.ok, status: res.status, body: parsed as T, rawText: text, retryAfterMs };
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      const usedTimeout = overrideTimeoutMs ?? this.timeoutMs;
      const errorBody: OpenAIErrorResponse['body'] = {
        error: {
          message: isAbort
            ? `Request aborted after ${Date.now() - start}ms (timeout ${usedTimeout}ms)`
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

      // Use Retry-After from provider if present (e.g. Kimi 429), else use fixed backoff
      const delay = result.retryAfterMs ?? BACKOFF_MS[attempt] ?? 3000;
      logger.warn(
        { status: result.status, attempt: attempt + 1, retryInMs: delay, retryAfterHeader: result.retryAfterMs != null },
        'upstream_retrying',
      );
      await sleep(delay);
      attempt++;
    }
  }

  async listModels(): Promise<ProviderResponse<OpenAIModelsResponse | OpenAIErrorResponse>> {
    return this.request<OpenAIModelsResponse>('GET', '/models');
  }

  /**
   * Non-stream fallback: sends a plain (non-streaming) chat completion request.
   * Used when a streaming attempt 504s/stalls and we need a guaranteed response
   * rather than another streaming retry.
   *
   * Uses NON_STREAM_FALLBACK_TIMEOUT_MS (default 60s) instead of the full
   * REQUEST_TIMEOUT_MS so a stalled provider doesn't block the client for 2 minutes.
   * Does NOT retry on failure — if the fallback itself fails the caller reports the error.
   */
  async createChatCompletionNonStream(
    body: OpenAIChatCompletionsRequest,
  ): Promise<ProviderResponse<OpenAIChatCompletionsResponse | OpenAIErrorResponse>> {
    // Single attempt only — no retry loop. The caller already tried the stream
    // path and it failed; burning retry time here makes the UX worse.
    return this.requestOnce<OpenAIChatCompletionsResponse>(
      'POST',
      '/chat/completions',
      { ...body, stream: false },
      this.nonStreamFallbackTimeoutMs,
    );
  }

  async createChatCompletion(
    body: OpenAIChatCompletionsRequest,
    backupModel?: string | null,
  ): Promise<ProviderResponse<OpenAIChatCompletionsResponse | OpenAIErrorResponse>> {
    const logger = getLogger();

    // Cascade to backup immediately on transient server errors — before retrying.
    // This avoids waiting through multiple timeouts on a dead primary.
    const result = await this.requestOnce<OpenAIChatCompletionsResponse>('POST', '/chat/completions', body);

    // Only cascade when the backup is a DIFFERENT model — cascading to the same
    // model just re-runs the identical failing request.
    if (!result.ok && backupModel && backupModel !== body.model && BACKUP_TRIGGER_STATUSES.has(result.status)) {
      logger.warn(
        { primaryModel: body.model, backupModel, primaryStatus: result.status },
        'upstream_cascade',
      );
      const backupResult = await this.request<OpenAIChatCompletionsResponse>(
        'POST',
        '/chat/completions',
        { ...body, model: backupModel },
      );
      return { ...backupResult, cascadedToBackup: true };
    }

    // For 429 and other retryable statuses without a backup, use full retry logic
    if (!result.ok && RETRYABLE_STATUSES.has(result.status)) {
      return this.request<OpenAIChatCompletionsResponse>('POST', '/chat/completions', body);
    }

    return result;
  }

  async createChatCompletionStream(
    body: OpenAIChatCompletionsRequest,
    backupModel?: string | null,
    externalSignal?: AbortSignal,
  ): Promise<{ ok: true; response: globalThis.Response; cascadedToBackup?: boolean } | { ok: false; status: number; body: unknown; bothStreamsFailed?: boolean }> {
    const logger = getLogger();
    let attempt = 0;

    while (true) {
      const result = await this.streamOnce(body, externalSignal);

      if (result.ok) {
        return result;
      }

      // Cascade to backup immediately — skip if backup === primary (self-loop)
      if (backupModel && backupModel !== body.model && BACKUP_TRIGGER_STATUSES.has(result.status)) {
        logger.warn(
          { primaryModel: body.model, backupModel, primaryStatus: result.status },
          'upstream_cascade',
        );
        const backupResult = await this.streamOnce({ ...body, model: backupModel }, externalSignal);
        if (backupResult.ok) {
          return { ...backupResult, cascadedToBackup: true };
        }
        // Both primary AND backup failed — caller should skip non-stream
        return { ...backupResult, bothStreamsFailed: true };
      }

      // Non-retryable errors — return immediately
      if (!RETRYABLE_STATUSES.has(result.status)) {
        return result;
      }

      // 504/503 with no usable backup: skip retries immediately so caller
      // can attempt non-stream fallback without waiting 1s + 3s for nothing.
      if (result.status === 504 || result.status === 503) {
        return result;
      }

      // For remaining retryable statuses (429 rate-limit)
      if (attempt >= MAX_RETRIES) {
        return result;
      }

      const retryAfterMs = (result as { retryAfterMs?: number }).retryAfterMs;
      const delay = retryAfterMs ?? BACKOFF_MS[attempt] ?? 3000;
      logger.warn(
        { status: result.status, attempt: attempt + 1, retryInMs: delay, retryAfterHeader: retryAfterMs != null },
        'upstream_stream_retrying',
      );
      await sleep(delay);
      attempt++;
    }
  }

  private async streamOnce(
    body: OpenAIChatCompletionsRequest,
    externalSignal?: AbortSignal,
  ): Promise<{ ok: true; response: globalThis.Response; status: number } | { ok: false; status: number; body: unknown; retryAfterMs?: number }> {
    const url = `${this.baseUrl}/chat/completions`;

    // Connect timeout: configurable via STREAM_CONNECT_TIMEOUT_MS (default 12s).
    // Must be below the provider's own 15s stall ceiling.
    const CONNECT_TIMEOUT_MS = getConfig().streamConnectTimeoutMs;
    const connectController = new AbortControllerWithTimeout(CONNECT_TIMEOUT_MS);

    // Merge with caller's abort signal if provided (idle timer, etc.)
    let signal: AbortSignal = connectController.signal;
    if (externalSignal) {
      // Create a combined signal that fires when either aborts
      const combined = AbortSignal.any
        ? AbortSignal.any([connectController.signal, externalSignal])
        : connectController.signal; // fallback for older Node — external signal used directly
      signal = combined;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.authHeader,
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      });

      // Connection established — clear the connect timeout. The caller's idle
      // timer (externalSignal) now controls how long we wait for chunks.
      connectController.clear();

      if (!res.ok) {
        const text = await res.text();
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }

        // Read Retry-After for 429 responses
        let retryAfterMs: number | undefined;
        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          if (retryAfter) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds) && seconds > 0) {
              retryAfterMs = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
            }
          }
        }

        return { ok: false, status: res.status, body: parsed, retryAfterMs };
      }

      return { ok: true, response: res, status: res.status };
    } catch (err) {
      connectController.clear();
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      return {
        ok: false,
        status: isAbort ? 504 : 502,
        body: {
          error: {
            message: isAbort
              ? `Stream connection timed out after ${CONNECT_TIMEOUT_MS}ms`
              : err instanceof Error ? err.message : String(err),
            type: isAbort ? 'timeout_error' : 'network_error',
          },
        },
      };
    }
  }
}
