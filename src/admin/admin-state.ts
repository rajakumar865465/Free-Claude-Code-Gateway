import { RequestLog } from './request-log';
import { StatsEngine } from './stats-engine';
import { ConfigManager } from './config-manager';
import { ModelRegistry } from './model-registry';
import { ConnectionTester } from './connection-tester';

export class AdminState {
  readonly requestLog: RequestLog;
  readonly statsEngine: StatsEngine;
  readonly configManager: ConfigManager;
  readonly modelRegistry: ModelRegistry;
  readonly connectionTester: ConnectionTester;

  constructor(clearLogOnRestart = false) {
    this.requestLog = new RequestLog(1000, clearLogOnRestart);
    this.configManager = new ConfigManager();
    this.modelRegistry = new ModelRegistry();
    this.statsEngine = new StatsEngine(this.requestLog);
    this.statsEngine.setPrices(
      this.configManager.getInputPricePerMillion(),
      this.configManager.getOutputPricePerMillion(),
    );
    this.connectionTester = new ConnectionTester(this.configManager);
  }
}
