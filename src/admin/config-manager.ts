import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig, resetConfigCache } from '../config/env';
import { loadJson, saveJson } from './persist';
import { setLogLevel } from '../utils/logger';
import type { ProviderManager } from './provider-manager';

export interface RuntimeConfig {
  bluesmindsBaseUrl: string;
  apiKeySet: boolean;
  defaultModel: string;
  strictModelMapping: boolean;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  allowedOrigins: string[];
  maxBodySize: string;
  debugLogs: boolean;
  proxyApiKeyStatus: 'set' | 'missing';
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  restartRequired: boolean;
  restartReasons: string[];
}

export interface ConfigPatch {
  bluesmindsBaseUrl?: string;
  bluesmindsApiKey?: string;
  defaultModel?: string;
  strictModelMapping?: boolean;
  rateLimitPerMinute?: number;
  requestTimeoutMs?: number;
  allowedOrigins?: string[];
  maxBodySize?: string;
  debugLogs?: boolean;
  proxyApiKey?: string;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

const MAX_BODY_SIZE_REGEX = /^(\d+)\s*(b|kb|mb|gb)$/i;
const STORAGE_KEY = 'config-overrides';

interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  strict?: boolean;
  rateLimit?: number;
  timeout?: number;
  allowedOrigins?: string[];
  maxBodySize?: string;
  debug?: boolean;
  proxyApiKey?: string;
  inputPrice?: number;
  outputPrice?: number;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class ConfigManager {
  private apiKeyOverride: string | undefined = undefined;
  private baseUrlOverride: string | undefined = undefined;
  private defaultModelOverride: string | undefined = undefined;
  private strictOverride: boolean | undefined = undefined;
  private rateLimitOverride: number | undefined = undefined;
  private timeoutOverride: number | undefined = undefined;
  private allowedOriginsOverride: string[] | undefined = undefined;
  private maxBodySizeOverride: string | undefined = undefined;
  private debugOverride: boolean | undefined = undefined;
  private proxyApiKeyOverride: string | undefined = undefined;
  private inputPriceOverride: number | undefined = undefined;
  private outputPriceOverride: number | undefined = undefined;
  private _restartRequired = false;
  private _restartReasons: string[] = [];
  private readonly providerManager?: ProviderManager;

  constructor(providerManager?: ProviderManager) {
    this.providerManager = providerManager;
    const stored = loadJson<StoredConfig>(STORAGE_KEY, {});
    if (stored.apiKey !== undefined) this.apiKeyOverride = stored.apiKey;
    if (stored.baseUrl !== undefined) this.baseUrlOverride = stored.baseUrl;
    if (stored.defaultModel !== undefined) this.defaultModelOverride = stored.defaultModel;
    if (stored.strict !== undefined) this.strictOverride = stored.strict;
    if (stored.rateLimit !== undefined) this.rateLimitOverride = stored.rateLimit;
    if (stored.timeout !== undefined) this.timeoutOverride = stored.timeout;
    if (stored.allowedOrigins !== undefined) this.allowedOriginsOverride = stored.allowedOrigins;
    if (stored.maxBodySize !== undefined) this.maxBodySizeOverride = stored.maxBodySize;
    if (stored.debug !== undefined) {
      this.debugOverride = stored.debug;
      setLogLevel(stored.debug ? 'debug' : 'info');
    }
    if (stored.proxyApiKey !== undefined) this.proxyApiKeyOverride = stored.proxyApiKey;
    if (stored.inputPrice !== undefined) this.inputPriceOverride = stored.inputPrice;
    if (stored.outputPrice !== undefined) this.outputPriceOverride = stored.outputPrice;
    this.syncToProcessEnv();
  }

  getApiKey(): string {
    // Active provider takes highest priority
    if (this.providerManager) {
      const activeKey = this.providerManager.getActiveApiKey();
      if (activeKey) return activeKey;
    }
    if (this.apiKeyOverride !== undefined) return this.apiKeyOverride;
    return getConfig().bluesmindsApiKey;
  }

  getBaseUrl(): string {
    // Active provider takes highest priority
    if (this.providerManager) {
      const active = this.providerManager.getActive();
      if (active) return active.baseUrl.replace(/\/+$/, '');
    }
    const v = this.baseUrlOverride ?? getConfig().bluesmindsBaseUrl;
    return v.replace(/\/+$/, '');
  }

  getDefaultModel(): string {
    // Active provider takes highest priority
    if (this.providerManager) {
      const active = this.providerManager.getActive();
      if (active && active.defaultModel) return active.defaultModel;
    }
    return this.defaultModelOverride ?? getConfig().defaultModel;
  }

  isStrictMapping(): boolean {
    return this.strictOverride ?? getConfig().strictModelMapping;
  }

  getRateLimitPerMinute(): number {
    return this.rateLimitOverride ?? getConfig().rateLimitPerMinute;
  }

  getRequestTimeoutMs(): number {
    return this.timeoutOverride ?? getConfig().requestTimeoutMs;
  }

  getAllowedOrigins(): string[] {
    return this.allowedOriginsOverride ?? getConfig().allowedOrigins;
  }

  getMaxBodySize(): string {
    return this.maxBodySizeOverride ?? getConfig().maxBodySize;
  }

  isDebugLogs(): boolean {
    return this.debugOverride ?? getConfig().debugLogs;
  }

  getProxyApiKey(): string {
    if (this.proxyApiKeyOverride !== undefined) return this.proxyApiKeyOverride;
    return getConfig().proxyApiKey;
  }

  getProxyApiKeyStatus(): 'set' | 'missing' {
    return this.getProxyApiKey().length > 0 ? 'set' : 'missing';
  }

  getInputPricePerMillion(): number {
    return this.inputPriceOverride ?? 0;
  }

  getOutputPricePerMillion(): number {
    return this.outputPriceOverride ?? 0;
  }

  get restartRequired(): boolean {
    return this._restartRequired;
  }

  get restartReasons(): string[] {
    return [...this._restartReasons];
  }

  clearRestartRequired(): void {
    this._restartRequired = false;
    this._restartReasons = [];
  }

  snapshot(): RuntimeConfig {
    return {
      bluesmindsBaseUrl: this.getBaseUrl(),
      apiKeySet: this.getApiKey().length > 0,
      defaultModel: this.getDefaultModel(),
      strictModelMapping: this.isStrictMapping(),
      rateLimitPerMinute: this.getRateLimitPerMinute(),
      requestTimeoutMs: this.getRequestTimeoutMs(),
      allowedOrigins: this.getAllowedOrigins(),
      maxBodySize: this.getMaxBodySize(),
      debugLogs: this.isDebugLogs(),
      proxyApiKeyStatus: this.getProxyApiKeyStatus(),
      inputPricePerMillion: this.getInputPricePerMillion(),
      outputPricePerMillion: this.getOutputPricePerMillion(),
      restartRequired: this._restartRequired,
      restartReasons: [...this._restartReasons],
    };
  }

  validatePatch(patch: unknown): ConfigPatch {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ConfigValidationError('Config body must be a JSON object.');
    }
    const p = patch as Record<string, unknown>;
    const out: ConfigPatch = {};

    if ('bluesmindsBaseUrl' in p) {
      const v = p.bluesmindsBaseUrl;
      if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) {
        throw new ConfigValidationError('bluesmindsBaseUrl must start with http:// or https://');
      }
      out.bluesmindsBaseUrl = v.replace(/\/+$/, '');
    }

    if ('bluesmindsApiKey' in p) {
      const v = p.bluesmindsApiKey;
      if (typeof v !== 'string') {
        throw new ConfigValidationError('bluesmindsApiKey must be a string.');
      }
      out.bluesmindsApiKey = v;
    }

    if ('defaultModel' in p) {
      const v = p.defaultModel;
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new ConfigValidationError('defaultModel must be a non-empty string.');
      }
      out.defaultModel = v.trim();
    }

    if ('strictModelMapping' in p) {
      const v = p.strictModelMapping;
      if (typeof v !== 'boolean') {
        throw new ConfigValidationError('strictModelMapping must be a boolean.');
      }
      out.strictModelMapping = v;
    }

    if ('rateLimitPerMinute' in p) {
      const v = p.rateLimitPerMinute;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 10000) {
        throw new ConfigValidationError('rateLimitPerMinute must be a number between 1 and 10000.');
      }
      out.rateLimitPerMinute = Math.floor(v);
    }

    if ('requestTimeoutMs' in p) {
      const v = p.requestTimeoutMs;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1000 || v > 600000) {
        throw new ConfigValidationError('requestTimeoutMs must be a number between 1000 and 600000.');
      }
      out.requestTimeoutMs = Math.floor(v);
    }

    if ('allowedOrigins' in p) {
      const v = p.allowedOrigins;
      if (!Array.isArray(v) || !v.every((o) => typeof o === 'string')) {
        throw new ConfigValidationError('allowedOrigins must be an array of strings.');
      }
      out.allowedOrigins = v.map((o) => o.trim()).filter((o) => o.length > 0);
    }

    if ('maxBodySize' in p) {
      const v = p.maxBodySize;
      if (typeof v !== 'string' || !MAX_BODY_SIZE_REGEX.test(v.trim())) {
        throw new ConfigValidationError(
          'maxBodySize must be a positive integer followed by a size unit (e.g. 20mb, 1gb).',
        );
      }
      out.maxBodySize = v.trim();
    }

    if ('debugLogs' in p) {
      const v = p.debugLogs;
      if (typeof v !== 'boolean') {
        throw new ConfigValidationError('debugLogs must be a boolean.');
      }
      out.debugLogs = v;
    }

    if ('proxyApiKey' in p) {
      const v = p.proxyApiKey;
      if (typeof v !== 'string') {
        throw new ConfigValidationError('proxyApiKey must be a string.');
      }
      out.proxyApiKey = v;
    }

    if ('inputPricePerMillion' in p) {
      const v = p.inputPricePerMillion;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
        throw new ConfigValidationError('inputPricePerMillion must be a number between 0 and 100000.');
      }
      out.inputPricePerMillion = v;
    }

    if ('outputPricePerMillion' in p) {
      const v = p.outputPricePerMillion;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
        throw new ConfigValidationError('outputPricePerMillion must be a number between 0 and 100000.');
      }
      out.outputPricePerMillion = v;
    }

    return out;
  }

  applyPatch(patch: ConfigPatch): void {
    if (patch.bluesmindsBaseUrl !== undefined) this.baseUrlOverride = patch.bluesmindsBaseUrl;
    if (patch.bluesmindsApiKey !== undefined) this.apiKeyOverride = patch.bluesmindsApiKey;
    if (patch.defaultModel !== undefined) this.defaultModelOverride = patch.defaultModel;
    if (patch.strictModelMapping !== undefined) this.strictOverride = patch.strictModelMapping;
    if (patch.rateLimitPerMinute !== undefined) this.rateLimitOverride = patch.rateLimitPerMinute;
    if (patch.requestTimeoutMs !== undefined) this.timeoutOverride = patch.requestTimeoutMs;
    if (patch.allowedOrigins !== undefined) this.allowedOriginsOverride = patch.allowedOrigins;
    if (patch.debugLogs !== undefined) {
      this.debugOverride = patch.debugLogs;
      setLogLevel(patch.debugLogs ? 'debug' : 'info');
    }
    if (patch.proxyApiKey !== undefined) this.proxyApiKeyOverride = patch.proxyApiKey;
    if (patch.inputPricePerMillion !== undefined) this.inputPriceOverride = patch.inputPricePerMillion;
    if (patch.outputPricePerMillion !== undefined) this.outputPriceOverride = patch.outputPricePerMillion;

    // Track restart-required changes
    if (patch.maxBodySize !== undefined) {
      const oldVal = this.maxBodySizeOverride ?? getConfig().maxBodySize;
      if (patch.maxBodySize !== oldVal) {
        this.maxBodySizeOverride = patch.maxBodySize;
        this._restartRequired = true;
        if (!this._restartReasons.includes('Max Body Size')) {
          this._restartReasons.push('Max Body Size');
        }
      }
    }

    this.persist();
    this.syncToProcessEnv();
    this.syncToEnvFile();
  }

  private syncToProcessEnv(): void {
    if (this.baseUrlOverride !== undefined) process.env.BLUESMINDS_BASE_URL = this.baseUrlOverride;
    if (this.apiKeyOverride !== undefined) process.env.BLUESMINDS_API_KEY = this.apiKeyOverride;
    if (this.defaultModelOverride !== undefined) process.env.DEFAULT_MODEL = this.defaultModelOverride;
    if (this.strictOverride !== undefined) process.env.STRICT_MODEL_MAPPING = String(this.strictOverride);
    if (this.rateLimitOverride !== undefined) process.env.RATE_LIMIT_PER_MINUTE = String(this.rateLimitOverride);
    if (this.timeoutOverride !== undefined) process.env.REQUEST_TIMEOUT_MS = String(this.timeoutOverride);
    if (this.maxBodySizeOverride !== undefined) process.env.MAX_BODY_SIZE = this.maxBodySizeOverride;
    if (this.debugOverride !== undefined) process.env.DEBUG_LOGS = String(this.debugOverride);
    if (this.proxyApiKeyOverride !== undefined) process.env.PROXY_API_KEY = this.proxyApiKeyOverride;
    if (this.allowedOriginsOverride !== undefined) {
      process.env.ALLOWED_ORIGINS = this.allowedOriginsOverride.join(',');
    }
    resetConfigCache();
  }

  private persist(): void {
    const data: StoredConfig = {};
    if (this.apiKeyOverride !== undefined) data.apiKey = this.apiKeyOverride;
    if (this.baseUrlOverride !== undefined) data.baseUrl = this.baseUrlOverride;
    if (this.defaultModelOverride !== undefined) data.defaultModel = this.defaultModelOverride;
    if (this.strictOverride !== undefined) data.strict = this.strictOverride;
    if (this.rateLimitOverride !== undefined) data.rateLimit = this.rateLimitOverride;
    if (this.timeoutOverride !== undefined) data.timeout = this.timeoutOverride;
    if (this.allowedOriginsOverride !== undefined) data.allowedOrigins = this.allowedOriginsOverride;
    if (this.maxBodySizeOverride !== undefined) data.maxBodySize = this.maxBodySizeOverride;
    if (this.debugOverride !== undefined) data.debug = this.debugOverride;
    if (this.proxyApiKeyOverride !== undefined) data.proxyApiKey = this.proxyApiKeyOverride;
    if (this.inputPriceOverride !== undefined) data.inputPrice = this.inputPriceOverride;
    if (this.outputPriceOverride !== undefined) data.outputPrice = this.outputPriceOverride;
    saveJson(STORAGE_KEY, data);
  }

  private syncToEnvFile(): void {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;

    let content = fs.readFileSync(envPath, 'utf-8');

    const replaceLine = (key: string, value: string): void => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(content)) {
        content = content.replace(regex, line);
      } else {
        content = content.trimEnd() + `\n${line}\n`;
      }
    };

    // NOTE: API keys (BLUESMINDS_API_KEY, PROXY_API_KEY) are intentionally NOT
    // written back to .env here. Writing secrets to disk on every config update
    // risks leaking them into version control, container image layers, or log
    // collectors. Keys are persisted securely in .blueclaude-data/config-overrides.json
    // (which should be outside the repo root) and loaded from there at startup.
    if (this.baseUrlOverride !== undefined) replaceLine('BLUESMINDS_BASE_URL', this.baseUrlOverride);
    if (this.defaultModelOverride !== undefined) replaceLine('DEFAULT_MODEL', this.defaultModelOverride);
    if (this.strictOverride !== undefined) replaceLine('STRICT_MODEL_MAPPING', String(this.strictOverride));
    if (this.rateLimitOverride !== undefined) replaceLine('RATE_LIMIT_PER_MINUTE', String(this.rateLimitOverride));
    if (this.timeoutOverride !== undefined) replaceLine('REQUEST_TIMEOUT_MS', String(this.timeoutOverride));
    if (this.maxBodySizeOverride !== undefined) replaceLine('MAX_BODY_SIZE', this.maxBodySizeOverride);
    if (this.debugOverride !== undefined) replaceLine('DEBUG_LOGS', String(this.debugOverride));
    if (this.allowedOriginsOverride !== undefined) {
      replaceLine('ALLOWED_ORIGINS', this.allowedOriginsOverride.join(','));
    }

    // Write atomically via temp file
    const tmp = `${envPath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, envPath);
  }

  update(patch: unknown): RuntimeConfig {
    const valid = this.validatePatch(patch);
    this.applyPatch(valid);
    return this.snapshot();
  }
}
