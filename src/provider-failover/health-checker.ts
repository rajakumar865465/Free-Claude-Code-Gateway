import type { ProviderFailoverEngine } from './engine';

export class HealthChecker {
  private timer: ReturnType<typeof setTimeout> | null = null;

  start(engine: ProviderFailoverEngine): void {
    if (this.timer !== null) return;

    // Open the startup grace window NOW (process start) so that any failure —
    // including from the very first probe — can only mark a provider DEGRADED,
    // never hard-down, until the outbound network stack has warmed up.
    engine.beginStartupGrace();

    const run = async () => {
      try {
        await engine.runHealthChecks();
      } catch (err) {
        console.error('[ProviderFailover] Health check failed:', err);
      }

      const cfg = engine.getConfig();
      const intervalMs = Math.max(60, cfg.health_check_interval) * 1000;
      this.timer = setTimeout(run, intervalMs);
      // Don't prevent process exit
      if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
        (this.timer as unknown as { unref: () => void }).unref();
      }
    };

    // Delay the FIRST health check a few seconds after startup. Probing
    // immediately races the network stack / DNS / outbound TLS and produces the
    // 40-60ms "fetch failed" false-negatives seen in the logs. Clamp to 5-10s.
    const cfg = engine.getConfig();
    const delaySecs = Math.min(10, Math.max(5, cfg.first_check_delay_seconds ?? 7));
    this.timer = setTimeout(() => {
      void run();
    }, delaySecs * 1000);
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export const healthChecker = new HealthChecker();
