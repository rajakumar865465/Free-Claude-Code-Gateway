import type { ConfigManager } from './config-manager';
import { AbortControllerWithTimeout } from '../utils/timeout';
import { getLogger } from '../utils/logger';

export type ConnectionTestResult =
  | {
      success: true;
      upstreamStatus: number;
      latencyMs: number;
      preview: string;
    }
  | {
      success: false;
      upstreamStatus: number | null;
      latencyMs: number;
      error: string;
    };

const TEST_TIMEOUT_MS = 30_000;
const PREVIEW_MAX_CHARS = 200;

function humanizeStatus(status: number, bodyText: string): string {
  const lower = bodyText.toLowerCase();
  if (status === 401) return 'API key invalid or missing. Update the upstream key in Settings → Provider Connection.';
  if (status === 403) return 'Account does not have access to this model. Try Sync Models to see available models.';
  if (status === 404) return 'Base URL or model is invalid. Check your Upstream Base URL and Default Model in Settings.';
  if (status === 429) return 'Provider rate limited this request. Wait a moment and try again.';
  if (status === 503) return 'Provider is temporarily unavailable. Try again later.';
  if (status >= 500) return `Provider server error (${status}). Try again later.`;
  if (lower.includes('timeout')) return 'Request timed out. Increase Request Timeout in Settings → Limits.';
  if (lower.includes('overloaded')) return 'Provider is overloaded. Try again later.';
  return `Upstream returned status ${status}`;
}

export class ConnectionTester {
  constructor(private readonly config: ConfigManager) {}

  async run(): Promise<ConnectionTestResult> {
    const logger = getLogger();
    const defaultModel = this.config.getDefaultModel();
    if (!defaultModel) {
      return {
        success: false,
        upstreamStatus: null,
        latencyMs: 0,
        error: 'No default model configured. Set a Default Model in Settings → Provider Connection.',
      };
    }

    const start = Date.now();
    const controller = new AbortControllerWithTimeout(TEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.config.getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.getApiKey()}`,
        },
        body: JSON.stringify({
          model: defaultModel,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 16,
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (res.ok) {
        const body = parsed as { choices?: Array<{ message?: { content?: string } }> } | null;
        const content = body?.choices?.[0]?.message?.content ?? '';
        const preview = (content || '').slice(0, PREVIEW_MAX_CHARS);
        return { success: true, upstreamStatus: res.status, latencyMs, preview };
      }
      const errBody = parsed as { error?: { message?: string } } | null;
      const rawMsg = errBody?.error?.message ?? '';
      const error = humanizeStatus(res.status, rawMsg || text);
      return { success: false, upstreamStatus: res.status, latencyMs, error };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      const message = isAbort
        ? `Request timed out after ${TEST_TIMEOUT_MS}ms. Increase Request Timeout in Settings → Limits.`
        : err instanceof Error
          ? err.message
          : String(err);
      logger.warn({ err: message }, 'connection_test_failed');
      return {
        success: false,
        upstreamStatus: null,
        latencyMs,
        error: message,
      };
    } finally {
      controller.clear();
    }
  }
}
