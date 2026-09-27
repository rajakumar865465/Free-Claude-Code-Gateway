import type { ProviderManager } from '../admin/provider-manager';
import { DATABRICKS_BASE_URL } from '../admin/provider-manager';
import type { ProviderResponse } from '../services/bluesminds.service';
import type { FailoverStorage } from './storage';
import type { FailoverConfig, ProviderHealthStatus, ProviderStatus, SwitchLogEntry } from './types';
import { getLogger } from '../utils/logger';

const FAILOVER_TRIGGER_STATUSES = new Set([429, 500, 502, 503, 529]);
const PAGE_SIZE = 25;
// Cap accumulated error counts so a long-running process doesn't show 500+.
const MAX_ERROR_COUNT = 100;

// Hard-down terminal states — these carry a cooldown and rank worst for routing.
const HARD_DOWN_STATUSES = new Set<ProviderHealthStatus>([
  'UNREACHABLE',
  'AUTH_ERROR',
  'UNHEALTHY',
]);

/**
 * Turn a thrown fetch error into a precise, human-readable cause instead of the
 * opaque "fetch failed" that Node's undici surfaces at the top level. The real
 * reason lives in `err.cause.code` (ENOTFOUND, ECONNREFUSED, ...) — without
 * digging it out, every transport failure looks identical in the logs, which is
 * exactly what made the startup false-negatives impossible to diagnose.
 */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'Request timed out (aborted)';

  // undici wraps the underlying syscall error in `.cause`.
  const cause = (err as { cause?: unknown })?.cause;
  const code =
    (cause as { code?: string })?.code ??
    (err as { code?: string })?.code ??
    undefined;

  const byCode: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed — host not found (ENOTFOUND)',
    EAI_AGAIN: 'DNS lookup timed out / temporary failure (EAI_AGAIN)',
    ECONNREFUSED: 'Connection refused (ECONNREFUSED)',
    ECONNRESET: 'Connection reset by peer (ECONNRESET)',
    ETIMEDOUT: 'Connection timed out (ETIMEDOUT)',
    EHOSTUNREACH: 'Host unreachable (EHOSTUNREACH)',
    ENETUNREACH: 'Network unreachable (ENETUNREACH)',
    EPIPE: 'Broken pipe (EPIPE)',
    UND_ERR_CONNECT_TIMEOUT: 'Connection timed out (UND_ERR_CONNECT_TIMEOUT)',
    UND_ERR_HEADERS_TIMEOUT: 'Headers timed out (UND_ERR_HEADERS_TIMEOUT)',
    UND_ERR_SOCKET: 'Socket closed unexpectedly (UND_ERR_SOCKET)',
    CERT_HAS_EXPIRED: 'TLS certificate expired (CERT_HAS_EXPIRED)',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS hostname mismatch (ERR_TLS_CERT_ALTNAME_INVALID)',
  };
  if (code && byCode[code]) return byCode[code];

  // TLS errors sometimes only carry a message, not a code.
  const causeMsg = (cause as { message?: string })?.message;
  if (causeMsg && /certificate|tls|ssl/i.test(causeMsg)) return `TLS error — ${causeMsg}`;
  if (causeMsg) return `${causeMsg}${code ? ` (${code})` : ''}`;

  if (code) return `Transport failure (${code})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Classify an HTTP status from the authoritative chat probe (or a real request)
 * into a provider health status.
 *
 * Principle: "healthy" means REACHABLE + AUTHENTICATED, not "this exact request
 * succeeded". A 400/404/422 from the chat endpoint means the server answered and
 * accepted our key — it's a request/model-shape issue, NOT a provider outage — so
 * we report HEALTHY. Only auth rejection, rate limiting, 5xx, and transport
 * failures are treated as unhealthy. This is what eliminates the false-negative
 * class where a provider serves real traffic but the health check marks it down.
 */
function classifyProbeStatus(status: number): { status: ProviderHealthStatus; error?: string } {
  if (status >= 200 && status < 300) return { status: 'HEALTHY' };
  if (status === 401 || status === 403) return { status: 'AUTH_ERROR', error: `Authentication error (${status})` };
  if (status === 429) return { status: 'RATE_LIMITED', error: 'Rate limited (429)' };
  if (status >= 500) return { status: 'UNREACHABLE', error: `HTTP ${status}` };
  if (status >= 400) {
    // Reachable + authed; the model/request was rejected (e.g. model_not_found).
    return { status: 'HEALTHY', error: `Reachable (request rejected ${status})` };
  }
  return { status: 'UNKNOWN' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function getFailureReason(status: number): string {
  if (status === 429) return '429_rate_limit';
  if (status === 402) return '402_payment_required';
  if (status === 401) return '401_auth_error';
  if (status === 404) return '404_not_found';
  if (status === 502) return '502_bad_gateway';
  if (status === 503) return '503_unavailable';
  if (status === 504) return '504_timeout';
  if (status === 500) return '500_server_error';
  if (status === 529) return '529_overloaded';
  return `${status}_error`;
}

export interface AltProvider {
  id: string;
  name: string;
  type?: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  azureApiVersion?: string;
  awsRegion?: string;
}

// ── Internal helper: single fetch with a timeout ───────────────────────────
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class ProviderFailoverEngine {
  private readonly logger = getLogger();

  /**
   * Epoch ms until which the startup grace window is active. While `Date.now()`
   * is below this, failures cannot escalate a provider past DEGRADED. `null`
   * means no grace window is active (the default, e.g. in tests) so behaviour is
   * unchanged unless `beginStartupGrace()` is explicitly called at boot.
   */
  private startupGraceUntil: number | null = null;

  constructor(
    private readonly storage: FailoverStorage,
    private readonly providerManager: ProviderManager,
  ) {}

  /**
   * Open the startup grace window. Called once by the health checker at boot.
   * During this window a provider can be marked DEGRADED but never put into
   * cooldown / hard-down, so the startup race (outbound stack not ready yet)
   * cannot poison the failover pool.
   */
  beginStartupGrace(): void {
    const cfg = this.storage.getConfig();
    const secs = Math.max(0, cfg.startup_grace_seconds ?? 0);
    this.startupGraceUntil = Date.now() + secs * 1000;
    this.logger.info({ graceSeconds: secs, until: new Date(this.startupGraceUntil).toISOString() }, 'failover_startup_grace_begin');
  }

  /** True while the post-boot grace window is still open. */
  isInStartupGrace(): boolean {
    return this.startupGraceUntil !== null && Date.now() < this.startupGraceUntil;
  }

  getConfig(): FailoverConfig {
    return this.storage.getConfig();
  }

  updateConfig(patch: Partial<FailoverConfig>): void {
    const current = this.storage.getConfig();
    this.storage.saveConfig({ ...current, ...patch });
  }

  toggleFailover(enabled: boolean): void {
    const current = this.storage.getConfig();
    this.storage.saveConfig({ ...current, failover_enabled: enabled });
  }

  getStatuses(): ProviderStatus[] {
    const providers = this.providerManager.getAll();
    const stored = this.storage.getStatuses();
    const storedMap = new Map(stored.map((s) => [s.id, s]));

    return providers.map(
      (p) =>
        storedMap.get(p.id) ?? {
          id: p.id,
          provider: p.name,
          model: p.defaultModel,
          status: 'UNKNOWN' as ProviderHealthStatus,
          errorCount: 0,
          lastChecked: '',
        },
    );
  }

  getSwitchLog(page = 1): { entries: SwitchLogEntry[]; total: number; page: number; pages: number } {
    const all = this.storage.getSwitchLog();
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.max(1, Math.min(page, pages));
    const start = (safePage - 1) * PAGE_SIZE;
    return { entries: all.slice(start, start + PAGE_SIZE), total, page: safePage, pages };
  }

  getTodaySwitchCount(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.storage.getSwitchLog().filter((e) => e.createdAt.startsWith(today)).length;
  }

  async runHealthCheckNow(): Promise<void> {
    await this.runHealthChecks();
  }

  /**
   * Reset all stored provider statuses — clears accumulated error counts and
   * stale UNREACHABLE/AUTH_ERROR states so the next health check starts fresh.
   */
  resetAllStatuses(): void {
    this.storage.saveStatuses([]);
    this.logger.info('failover_all_statuses_reset');
  }

  // ── Authoritative health check ─────────────────────────────────────────────
  //
  // Two-tier probe:
  //   Tier 1 (cheap)        GET {baseUrl}/models   — a 2xx instantly confirms
  //                         reachable + authed at zero token cost.
  //   Tier 2 (authoritative) POST {baseUrl}/chat/completions with a 1-token body,
  //                         using the EXACT production URL + auth header.
  //
  // Tier 2 only runs when Tier 1 is INCONCLUSIVE (any non-2xx, timeout, or network
  // error). This is the core fix for false negatives: many providers do not expose
  // GET /models (GitHub Models, some gateways) or 5xx/timeout that listing endpoint
  // while /chat/completions works perfectly. Previously such providers were marked
  // UNREACHABLE / AUTH_ERROR even though real traffic succeeded. By falling through
  // to a real chat request we test exactly what production tests, so a provider that
  // works manually is reported HEALTHY.
  async runHealthChecks(): Promise<void> {
    const providers = this.providerManager.getAll();
    if (providers.length === 0) return;
    const cfg = this.storage.getConfig();

    await Promise.allSettled(
      providers.map(async (provider) => {
        // Construct appropriate base URL based on provider type
        let baseUrl: string;
        if (provider.type === 'databricks') {
          baseUrl = DATABRICKS_BASE_URL;
        } else if (provider.type === 'aws_bedrock') {
          // Import and use the Bedrock URL constructor
          const { getBedrockBaseUrl } = await import('../utils/bedrock-url');
          try {
            baseUrl = getBedrockBaseUrl(provider.awsRegion || '');
          } catch (err) {
            // If region is missing or invalid, mark as unreachable and skip health check
            const errorMsg = err instanceof Error ? err.message : 'Invalid AWS region';
            this.logger.warn(
              { provider: provider.name, error: errorMsg },
              'health_check_bedrock_url_error',
            );
            const record = this.buildStatusRecord(provider, 'UNREACHABLE', errorMsg, {
              responseMs: undefined,
              source: 'active',
            });
            try {
              this.storage.upsertStatus(record);
            } catch (dbErr) {
              this.logger.error({ err: dbErr }, 'health_check_status_save_failed');
            }
            this.logger.info(
              {
                provider: provider.name,
                status: record.status,
                rawStatus: 'UNREACHABLE',
                errorCount: record.errorCount,
                consecutiveFailures: record.consecutiveFailures,
                responseMs: record.responseMs,
                probedVia: 'config',
                inStartupGrace: this.isInStartupGrace(),
                lastError: record.lastError,
              },
              'health_check_result',
            );
            return;
          }
        } else if (provider.type === 'azure_foundry') {
          // Mirror the production request path exactly (see messages.routes.ts):
          // the `responses` flavor lives under /openai/v1, the `chat_completions`
          // flavor keeps the raw endpoint and carries ?api-version= as a suffix.
          // Probing the bare host with a Bearer header (as the generic branch did)
          // always times out, which is why Azure was stuck DEGRADED.
          let azureBase = (provider.baseUrl || '').replace(/\/+$/, '');
          if (
            provider.azureApiFlavor === 'responses' &&
            !azureBase.includes('/openai') &&
            !azureBase.includes('/v1') &&
            !azureBase.includes('/models')
          ) {
            azureBase = `${azureBase}/openai/v1`;
          }
          baseUrl = azureBase;
        } else {
          baseUrl = provider.baseUrl.replace(/\/+$/, '');
        }

        // Azure AI Foundry authenticates with an `api-key` header (Bearer is only
        // valid for AAD tokens). Send both so either key form works, matching
        // BluesmindsService.authHeader.
        const bearer: Record<string, string> = provider.type === 'azure_foundry'
          ? { Authorization: `Bearer ${provider.apiKey}`, 'api-key': provider.apiKey }
          : { Authorization: `Bearer ${provider.apiKey}` };
        const start = Date.now();
        let status: ProviderHealthStatus = 'UNKNOWN';
        let lastError: string | undefined;
        let responseMs: number | undefined;
        let probedVia = 'models';

        // ── Tier 1: cheap GET /models fast-path ──────────────────────────────
        // Skip /models for Databricks and AWS Bedrock as they don't support this endpoint reliably
        let conclusive = false;
        let tier1Error: string | undefined;
        if (provider.type === 'databricks') {
          // Skip tier 1 for Databricks, go directly to tier 2 (chat completions)
          tier1Error = 'Databricks does not support /models endpoint';
        } else if (provider.type === 'aws_bedrock') {
          // Skip tier 1 for AWS Bedrock, go directly to tier 2 (chat completions)
          tier1Error = 'AWS Bedrock health check uses chat completions';
        } else if (provider.type === 'azure_foundry') {
          // Azure AI Foundry has no root GET /models — probe the real endpoint.
          tier1Error = 'Azure Foundry health check uses a direct probe';
        } else {
          try {
            const r = await fetchWithTimeout(
              `${baseUrl}/models`,
              { method: 'GET', headers: { Accept: 'application/json', ...bearer } },
              8_000,
            );
            responseMs = Date.now() - start;
            this.logger.debug(
              { provider: provider.name, url: `${baseUrl}/models`, status: r.status },
              'health_check_models',
            );
            if (r.ok) {
              status = 'HEALTHY';
              conclusive = true;
            }
            // Any non-2xx is INCONCLUSIVE — /models may simply be unsupported or
            // rate-limited while chat works. Fall through to the authoritative probe.
          } catch (err) {
            // timeout / network on /models — inconclusive, fall through. Capture the
            // *exact* transport cause (DNS/TLS/refused/timeout) instead of "fetch failed".
            tier1Error = describeFetchError(err);
            this.logger.debug(
              { provider: provider.name, url: `${baseUrl}/models`, error: tier1Error },
              'health_check_models_error',
            );
          }
        }

        // ── Tier 2: authoritative chat probe (real URL + real auth) ──────────
        if (!conclusive) {
          if (provider.type === 'azure_foundry') {
            // Azure has no /models tier, so the direct probe is the ONLY
            // authoritative signal — run it regardless of health_probe_uses_chat.
            if (provider.azureApiFlavor === 'responses') {
              probedVia = 'responses';
              const probe = await this.probeResponsesCompletion(provider, baseUrl, bearer);
              status = probe.status;
              lastError = probe.lastError ?? tier1Error;
              responseMs = probe.responseMs ?? responseMs;
            } else {
              probedVia = 'chat';
              const suffix = `?api-version=${provider.azureApiVersion || '2024-05-01-preview'}`;
              const probe = await this.probeChatCompletion(provider, baseUrl, bearer, suffix);
              status = probe.status;
              lastError = probe.lastError ?? tier1Error;
              responseMs = probe.responseMs ?? responseMs;
            }
          } else if (cfg.health_probe_uses_chat) {
            probedVia = 'chat';
            const probe = await this.probeChatCompletion(provider, baseUrl, bearer);
            status = probe.status;
            lastError = probe.lastError ?? tier1Error;
            responseMs = probe.responseMs ?? responseMs;
          } else {
            status = 'UNREACHABLE';
            lastError = tier1Error
              ? `/models check failed (${tier1Error}) and chat probe disabled`
              : '/models check failed and chat probe disabled';
            responseMs = responseMs ?? Date.now() - start;
          }
        }

        const record = this.buildStatusRecord(provider, status, lastError, {
          responseMs,
          source: 'active',
        });

        this.logger.info(
          {
            provider: provider.name,
            // Report the EFFECTIVE stored status (e.g. DEGRADED while under the
            // failure threshold or inside the startup grace window), not the raw
            // probe classification — so the log matches what the router sees.
            status: record.status,
            rawStatus: status,
            errorCount: record.errorCount,
            consecutiveFailures: record.consecutiveFailures,
            responseMs,
            probedVia,
            inStartupGrace: this.isInStartupGrace(),
            cooldownUntil: record.cooldownUntil,
            lastError: record.lastError,
          },
          'health_check_result',
        );

        try {
          this.storage.upsertStatus(record);
        } catch (dbErr) {
          this.logger.error({ err: dbErr }, 'health_check_status_save_failed');
        }
      }),
    );
  }

  /**
   * Authoritative probe — a minimal real chat completion that mirrors a
   * production request exactly (same path, method, and Bearer auth). Cheap
   * (max_tokens: 1) but definitive: it reflects what an actual request would do.
   */
  private async probeChatCompletion(
    provider: { name: string; defaultModel: string },
    baseUrl: string,
    bearer: Record<string, string>,
    urlSuffix = '',
  ): Promise<{ status: ProviderHealthStatus; lastError?: string; responseMs: number }> {
    const start = Date.now();
    try {
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions${urlSuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...bearer },
          body: JSON.stringify({
            model: provider.defaultModel,
            messages: [{ role: 'user', content: 'ping' }],
            max_completion_tokens: 1,
            stream: false,
          }),
        },
        12_000,
      );
      const responseMs = Date.now() - start;
      const c = classifyProbeStatus(r.status);
      this.logger.debug(
        { provider: provider.name, url: `${baseUrl}/chat/completions${urlSuffix}`, status: r.status, classified: c.status },
        'health_check_chat_probe',
      );
      return { status: c.status, lastError: c.error, responseMs };
    } catch (err) {
      const responseMs = Date.now() - start;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        status: 'UNREACHABLE',
        // Surface the precise transport cause (DNS/TLS/refused/timeout) so the
        // dashboard and logs explain *why*, not just "fetch failed".
        lastError: isAbort ? 'Chat probe timed out after 12s' : describeFetchError(err),
        responseMs,
      };
    }
  }

  /**
   * Authoritative probe for the Azure Responses API (`azureApiFlavor: 'responses'`).
   * Mirrors a production request: POST {baseUrl}/responses with the Responses
   * `input` shape and `api-key` auth. A generic /chat/completions probe would
   * 404 here, so this endpoint-correct probe is what stops Azure Responses
   * providers from being falsely marked DEGRADED/UNREACHABLE.
   */
  private async probeResponsesCompletion(
    provider: { name: string; defaultModel: string },
    baseUrl: string,
    bearer: Record<string, string>,
  ): Promise<{ status: ProviderHealthStatus; lastError?: string; responseMs: number }> {
    const start = Date.now();
    try {
      const r = await fetchWithTimeout(
        `${baseUrl}/responses`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...bearer },
          body: JSON.stringify({
            model: provider.defaultModel,
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
            max_output_tokens: 16,
            stream: false,
            store: false,
          }),
        },
        12_000,
      );
      const responseMs = Date.now() - start;
      const c = classifyProbeStatus(r.status);
      this.logger.debug(
        { provider: provider.name, url: `${baseUrl}/responses`, status: r.status, classified: c.status },
        'health_check_responses_probe',
      );
      return { status: c.status, lastError: c.error, responseMs };
    } catch (err) {
      const responseMs = Date.now() - start;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        status: 'UNREACHABLE',
        lastError: isAbort ? 'Responses probe timed out after 12s' : describeFetchError(err),
        responseMs,
      };
    }
  }

  /**
   * Build a ProviderStatus record with consistent error-count capping and
   * cooldown semantics. Used by BOTH the active health check and passive
   * (live-traffic) updates so status is computed identically everywhere.
   */
  private buildStatusRecord(
    provider: { id: string; name: string; defaultModel: string },
    status: ProviderHealthStatus,
    lastError: string | undefined,
    opts: { responseMs?: number; source: 'active' | 'passive' },
  ): ProviderStatus {
    const current = this.storage.getStatuses().find((s) => s.id === provider.id);
    const cfg = this.storage.getConfig();

    // ── Success → immediate full recovery ───────────────────────────────────
    // Any HEALTHY signal (success of a real request or a passing probe) wins
    // outright: reset failure counters and clear the cooldown so the dashboard
    // and the router agree the provider is back the instant it serves traffic.
    if (status === 'HEALTHY') {
      return {
        id: provider.id,
        provider: provider.name,
        model: provider.defaultModel,
        status: 'HEALTHY',
        errorCount: 0,
        consecutiveFailures: 0,
        lastChecked: new Date().toISOString(),
        lastError: undefined,
        responseMs: opts.responseMs ?? current?.responseMs,
        cooldownUntil: undefined,
        source: opts.source,
      };
    }

    // ── Failure → run it through the escalation state machine ────────────────
    const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1;
    const errorCount = Math.min((current?.errorCount ?? 0) + 1, MAX_ERROR_COUNT);

    // Active probes are speculative — require N consecutive failures before a
    // hard-down. Passive failures come from a real request that already
    // exhausted its retries, so they are authoritative (threshold of 1).
    const threshold = opts.source === 'active' ? Math.max(1, cfg.failure_threshold ?? 3) : 1;
    const inGrace = this.isInStartupGrace();
    const escalate = !inGrace && consecutiveFailures >= threshold;

    let effectiveStatus: ProviderHealthStatus;
    let cooldownUntil: string | undefined;

    if (escalate) {
      // Cross the threshold (or authoritative failure) → real hard-down + cooldown.
      effectiveStatus = status;
      const secs =
        status === 'RATE_LIMITED' ? Math.min(cfg.cooldown_seconds, 60) : cfg.cooldown_seconds;
      cooldownUntil = new Date(Date.now() + secs * 1000).toISOString();
    } else {
      // Below threshold or inside the startup grace window → DEGRADED. Still
      // routable, no cooldown: a transient glitch must never empty the pool.
      effectiveStatus = 'DEGRADED';
      cooldownUntil = undefined;
    }

    return {
      id: provider.id,
      provider: provider.name,
      model: provider.defaultModel,
      status: effectiveStatus,
      errorCount,
      consecutiveFailures,
      lastChecked: new Date().toISOString(),
      lastError: lastError || current?.lastError,
      responseMs: opts.responseMs ?? current?.responseMs,
      cooldownUntil,
      source: opts.source,
    };
  }

  async executeWithFailover<T>(
    primaryCall: () => Promise<ProviderResponse<T>>,
    makeAltCall: (provider: AltProvider) => Promise<ProviderResponse<T>>,
    context: { providerId: string; modelId: string; requestId?: string },
  ): Promise<ProviderResponse<T>> {
    const config = this.storage.getConfig();

    if (!config.failover_enabled) {
      const result = await primaryCall();
      // Passive health update even with failover disabled
      if (result.ok) {
        this.markProviderStatus(context.providerId, 'HEALTHY', '');
      }
      return result;
    }

    // Attempt 1
    const result1 = await primaryCall();
    if (result1.ok) {
      // Passive health: real request succeeded → mark provider healthy
      this.markProviderStatus(context.providerId, 'HEALTHY', '');
      return result1;
    }

    let finalResult = result1;

    // Only retry on transient errors
    if (FAILOVER_TRIGGER_STATUSES.has(result1.status)) {
      // Attempt 2
      await sleep(config.retry_delay_1);
      const result2 = await primaryCall();

      if (result2.ok) {
        this.markProviderStatus(context.providerId, 'HEALTHY', '');
        return result2;
      }

      if (FAILOVER_TRIGGER_STATUSES.has(result2.status)) {
        // Attempt 3
        await sleep(config.retry_delay_2);
        const result3 = await primaryCall();
        if (result3.ok) {
          this.markProviderStatus(context.providerId, 'HEALTHY', '');
          return result3;
        }
        finalResult = result3;
      } else {
        finalResult = result2;
      }
    }

    // Cross-provider failover applies to transient errors, 504 timeouts, AND 401s/404s
    const CROSS_PROVIDER_TRIGGERS = new Set([...FAILOVER_TRIGGER_STATUSES, 401, 404, 504]);

    if (!CROSS_PROVIDER_TRIGGERS.has(finalResult.status)) {
      return finalResult;
    }

    // All retries on primary exhausted — mark provider and try alternates
    const reason = getFailureReason(finalResult.status);
    const failStatus: ProviderHealthStatus =
      finalResult.status === 401 || finalResult.status === 403
        ? 'AUTH_ERROR'
        : finalResult.status === 429
          ? 'RATE_LIMITED'
          : 'UNREACHABLE';
    this.markProviderStatus(context.providerId, failStatus, reason);

    this.logger.warn(
      {
        providerId: context.providerId,
        modelId: context.modelId,
        status: finalResult.status,
        reason,
        requestId: context.requestId,
      },
      'failover_primary_exhausted',
    );

    // Try alternate providers
    const alternates = this.getRankedAlternates(context.providerId);
    if (alternates.length === 0) {
      this.logger.warn({ providerId: context.providerId }, 'failover_no_alternates');
      return this.allUnavailableResponse<T>();
    }

    for (const provider of alternates) {
      const altStart = Date.now();
      let altResult: ProviderResponse<T>;
      try {
        altResult = await makeAltCall(provider);
      } catch {
        continue;
      }
      const responseTimeMs = Date.now() - altStart;

      if (altResult.ok) {
        // Mark the working alternate as healthy (passive update)
        this.markProviderStatus(provider.id, 'HEALTHY', '');

        try {
          this.storage.appendSwitchLog({
            id: generateId(),
            fromProvider: context.providerId,
            fromModel: context.modelId,
            toProvider: provider.id,
            toModel: provider.defaultModel,
            reason,
            attemptNumber: 3,
            requestId: context.requestId,
            responseTimeMs,
            success: true,
            createdAt: new Date().toISOString(),
          });
        } catch (logErr) {
          this.logger.error({ err: logErr }, 'failover_switch_log_write_failed');
        }

        this.logger.info(
          {
            fromProvider: context.providerId,
            toProvider: provider.id,
            toModel: provider.defaultModel,
            reason,
            responseTimeMs,
            requestId: context.requestId,
          },
          'failover_switch_success',
        );

        return altResult;
      }

      // This alternate also failed — mark it and continue
      this.markProviderStatus(
        provider.id,
        altResult.status === 401 || altResult.status === 403 ? 'AUTH_ERROR' : 'RATE_LIMITED',
        getFailureReason(altResult.status),
      );

      this.logger.warn(
        { alternateProvider: provider.id, status: altResult.status },
        'failover_alternate_failed',
      );
    }

    this.logger.warn(
      { providerId: context.providerId, alternatesChecked: alternates.length },
      'failover_all_alternates_exhausted',
    );

    return this.allUnavailableResponse<T>();
  }

  /**
   * Passive health update — called by request routes when a provider
   * successfully serves or fails a real request. Resets error count on
   * success so that providers that work for real requests are reported
   * healthy in the dashboard even if active health checks fail.
   */
  public markProviderStatus(
    providerId: string,
    status: ProviderHealthStatus,
    lastError: string,
  ): void {
    try {
      const providers = this.providerManager.getAll();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;

      const record = this.buildStatusRecord(provider, status, lastError || undefined, {
        source: 'passive',
      });
      this.storage.upsertStatus(record);

      this.logger.debug(
        { providerId, status, errorCount: record.errorCount, cooldownUntil: record.cooldownUntil },
        'passive_health_update',
      );
    } catch (err) {
      this.logger.error({ err }, 'mark_provider_status_failed');
    }
  }

  getAlternateProviders(excludeProviderId: string): AltProvider[] {
    return this.getRankedAlternates(excludeProviderId);
  }

  logSwitchEvent(params: {
    fromProviderId: string;
    fromModel: string;
    toProviderId: string;
    toModel: string;
    reason: string;
    responseTimeMs?: number;
    requestId?: string;
  }): void {
    try {
      this.storage.appendSwitchLog({
        id: generateId(),
        fromProvider: params.fromProviderId,
        fromModel: params.fromModel,
        toProvider: params.toProviderId,
        toModel: params.toModel,
        reason: params.reason,
        attemptNumber: 1,
        requestId: params.requestId,
        responseTimeMs: params.responseTimeMs,
        success: true,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error({ err }, 'log_switch_event_failed');
    }
  }

  clearSwitchLog(): void {
    this.storage.clearSwitchLog();
  }

  /**
   * Best-first ordering of a provider's health for routing. Lower = better.
   * DEGRADED ranks above the hard-down states because it is still routable —
   * it represents a provider that glitched once but hasn't crossed the failure
   * threshold and is very likely still serving real traffic.
   */
  private static healthRank(s?: ProviderStatus): number {
    if (!s) return 1; // never checked — optimistically routable
    switch (s.status) {
      case 'HEALTHY':
        return 0;
      case 'UNKNOWN':
        return 1;
      case 'DEGRADED':
        return 2;
      case 'RATE_LIMITED':
        return 3;
      default:
        return 4; // AUTH_ERROR / UNREACHABLE / UNHEALTHY
    }
  }

  private getRankedAlternates(excludeProviderId: string): AltProvider[] {
    const providers = this.providerManager.getAll();
    const statuses = this.storage.getStatuses();
    const statusMap = new Map(statuses.map((s) => [s.id, s]));

    const now = Date.now();
    const isCoolingDown = (p: { id: string }): boolean => {
      const s = statusMap.get(p.id);
      if (!s?.cooldownUntil) return false;
      const until = new Date(s.cooldownUntil).getTime();
      return !Number.isNaN(until) && until > now;
    };

    const others = providers.filter((p) => p.id !== excludeProviderId);

    // Prefer providers NOT in an active cooldown window. Cooldown auto-recovers
    // (once it elapses, or the instant a real request succeeds and clears it).
    let eligible = others.filter((p) => !isCoolingDown(p));

    // INVARIANT: the failover router must never have zero candidates. If every
    // other provider is currently cooled down — which can happen transiently
    // during a network blip or right after startup — fall back to ALL of them
    // rather than returning nothing. A possibly-recovering provider is strictly
    // better than serving "all providers unavailable" while traffic still works.
    if (eligible.length === 0 && others.length > 0) {
      this.logger.warn(
        { excludeProviderId, total: others.length },
        'failover_all_alternates_cooling_down_using_full_pool',
      );
      eligible = others;
    }

    return eligible
      .sort((a, b) => {
        const ra = ProviderFailoverEngine.healthRank(statusMap.get(a.id));
        const rb = ProviderFailoverEngine.healthRank(statusMap.get(b.id));
        if (ra !== rb) return ra - rb;
        return (statusMap.get(a.id)?.errorCount ?? 0) - (statusMap.get(b.id)?.errorCount ?? 0);
      })
      .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        // For Databricks, always use the fixed base URL
        baseUrl: p.type === 'databricks'
          ? DATABRICKS_BASE_URL
          : p.type === 'aws_bedrock' && p.awsRegion
            ? `https://bedrock-mantle.${p.awsRegion}.amazonaws.com/v1`
            : p.baseUrl,
        apiKey: p.apiKey,
        defaultModel: p.defaultModel,
        azureApiVersion: p.azureApiVersion,
        awsRegion: p.awsRegion,
      }));
  }

  private allUnavailableResponse<T>(): ProviderResponse<T> {
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          message: 'All providers currently unavailable. Please try again in a few minutes.',
          type: 'overloaded_error',
        },
      } as unknown as T,
    };
  }
}
