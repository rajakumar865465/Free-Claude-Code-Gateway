/**
 * Provider health states, ordered best → worst:
 *   HEALTHY      — reachable + authenticated; eligible for routing.
 *   DEGRADED     — a probe (or single real request) just failed, but the provider
 *                  has NOT crossed the consecutive-failure threshold yet. Still
 *                  routable — this is the buffer that absorbs transient glitches and
 *                  startup races so a brief blip never poisons the failover pool.
 *   RATE_LIMITED — 429; temporarily backed off with a short cooldown.
 *   AUTH_ERROR   — 401/403; bad/expired key.
 *   UNREACHABLE  — transport failure (DNS/TLS/timeout/refused) or 5xx.
 *   UNHEALTHY    — generic hard-down terminal (alias for the above failure cluster
 *                  used when the specific cause is unknown).
 *   UNKNOWN      — never checked yet.
 */
export type ProviderHealthStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'UNREACHABLE'
  | 'UNHEALTHY'
  | 'UNKNOWN';

export interface ProviderStatus {
  id: string;
  provider: string;
  model: string;
  status: ProviderHealthStatus;
  errorCount: number;
  lastChecked: string;
  lastError?: string;
  responseMs?: number;
  /**
   * ISO timestamp until which this provider is in cooldown and must NOT be
   * selected as a failover alternate. Set on a hard failure (UNREACHABLE /
   * AUTH_ERROR / RATE_LIMITED) and cleared the moment the provider serves a
   * real request or passes a health probe — this is how a falsely-marked
   * provider recovers instead of being excluded forever.
   */
  cooldownUntil?: string;
  /** How the status was last determined — active probe vs live traffic. */
  source?: 'active' | 'passive';
  /**
   * Number of consecutive failures since the last success. A provider is only
   * escalated from DEGRADED to a hard-down state (UNREACHABLE/AUTH_ERROR/...)
   * once this crosses `failure_threshold`. Reset to 0 on any success. This is
   * what implements "require N consecutive failures before marking unhealthy"
   * and prevents a single false-negative probe from removing a provider that is
   * serving real traffic.
   */
  consecutiveFailures?: number;
}

export interface SwitchLogEntry {
  id: string;
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  reason: string;
  attemptNumber: number;
  requestId?: string;
  responseTimeMs?: number;
  success: boolean;
  createdAt: string;
}

export interface FailoverConfig {
  failover_enabled: boolean;
  health_check_interval: number;
  max_retries: number;
  retry_delay_1: number;
  retry_delay_2: number;
  alert_on_switch: boolean;
  /**
   * Seconds a provider stays in cooldown (excluded from failover selection)
   * after a hard failure. Recovery happens automatically once this elapses
   * or once the provider serves a real request.
   */
  cooldown_seconds: number;
  /**
   * If true, the active health check falls back to a minimal real
   * POST /chat/completions probe when GET /models is inconclusive. This makes
   * the health check authoritative (same URL + auth as production traffic).
   */
  health_probe_uses_chat: boolean;
  /**
   * Seconds to wait after process start before the FIRST active health check
   * runs. Gives the network stack / outbound DNS + TLS time to warm up so the
   * first probe doesn't false-negative with "fetch failed" in 40-60ms.
   */
  first_check_delay_seconds: number;
  /**
   * Grace window (seconds) after process start during which active/passive
   * failures may NOT escalate a provider past DEGRADED — no cooldown, no
   * removal from the routing pool. Absorbs the startup race where outbound
   * connections aren't ready yet.
   */
  startup_grace_seconds: number;
  /**
   * Number of CONSECUTIVE active probe failures required before a provider is
   * escalated from DEGRADED to a hard-down state and put into cooldown. A
   * single failed probe only marks DEGRADED (still routable).
   */
  failure_threshold: number;
}
