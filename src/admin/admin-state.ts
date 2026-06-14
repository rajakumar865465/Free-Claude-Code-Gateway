import { RequestLog } from './request-log';
import { StatsEngine } from './stats-engine';
import { ConfigManager } from './config-manager';
import { ModelRegistry } from './model-registry';
import { ConnectionTester } from './connection-tester';
import { ProviderManager } from './provider-manager';
import { ContextTracker } from '../auto-compact/context-tracker';
import { MemoryStore } from '../auto-compact/memory-store';

export class AdminState {
  readonly requestLog: RequestLog;
  readonly statsEngine: StatsEngine;
  readonly configManager: ConfigManager;
  readonly modelRegistry: ModelRegistry;
  readonly connectionTester: ConnectionTester;
  readonly providerManager: ProviderManager;
  readonly contextTracker: ContextTracker;
  readonly memoryStore: MemoryStore;

  constructor(clearLogOnRestart = false) {
    this.requestLog = new RequestLog(1000, clearLogOnRestart);
    this.providerManager = new ProviderManager();
    this.configManager = new ConfigManager(this.providerManager);
    this.modelRegistry = new ModelRegistry();
    this.statsEngine = new StatsEngine(this.requestLog);
    this.statsEngine.setPrices(
      this.configManager.getInputPricePerMillion(),
      this.configManager.getOutputPricePerMillion(),
    );
    this.connectionTester = new ConnectionTester(this.configManager);
    this.memoryStore = new MemoryStore();
    this.contextTracker = new ContextTracker(this.memoryStore);
  }
}
