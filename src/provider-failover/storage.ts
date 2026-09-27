import { loadJson, saveJson } from '../admin/persist';
import type { ProviderStatus, SwitchLogEntry, FailoverConfig } from './types';

const SWITCH_LOG_MAX = 1000;

const DEFAULT_CONFIG: FailoverConfig = {
  failover_enabled: true,
  health_check_interval: 300,
  max_retries: 3,
  retry_delay_1: 2000,
  retry_delay_2: 5000,
  alert_on_switch: false,
  cooldown_seconds: 120,
  health_probe_uses_chat: true,
  first_check_delay_seconds: 7,
  startup_grace_seconds: 30,
  failure_threshold: 3,
};

export class FailoverStorage {
  getConfig(): FailoverConfig {
    const stored = loadJson<Partial<FailoverConfig>>('failover-config', {});
    return { ...DEFAULT_CONFIG, ...stored };
  }

  saveConfig(config: FailoverConfig): void {
    saveJson('failover-config', config);
  }

  getStatuses(): ProviderStatus[] {
    return loadJson<ProviderStatus[]>('failover-provider-status', []);
  }

  /** Replace the entire status list (used by resetAllStatuses). */
  saveStatuses(statuses: ProviderStatus[]): void {
    saveJson('failover-provider-status', statuses);
  }

  upsertStatus(status: ProviderStatus): void {
    const all = this.getStatuses();
    const idx = all.findIndex((s) => s.id === status.id);
    if (idx >= 0) {
      all[idx] = status;
    } else {
      all.push(status);
    }
    saveJson('failover-provider-status', all);
  }

  getSwitchLog(): SwitchLogEntry[] {
    return loadJson<SwitchLogEntry[]>('failover-switch-log', []);
  }

  appendSwitchLog(entry: SwitchLogEntry): void {
    const log = this.getSwitchLog();
    log.unshift(entry);
    if (log.length > SWITCH_LOG_MAX) log.length = SWITCH_LOG_MAX;
    saveJson('failover-switch-log', log);
  }

  clearSwitchLog(): void {
    saveJson('failover-switch-log', []);
  }
}
