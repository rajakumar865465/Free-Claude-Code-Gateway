export interface AppConfig {
  bluesmindsApiKey: string;
  bluesmindsBaseUrl: string;
  port: number;
  defaultModel: string;
  strictModelMapping: boolean;
  proxyApiKey: string;
  requestTimeoutMs: number;
  rateLimitPerMinute: number;
  maxBodySize: string;
  allowedOrigins: string[];
  debugLogs: boolean;
  adminPassword: string;
  nodeEnv: 'development' | 'production' | 'test';
  version: string;
  name: string;
  clearLogOnRestart: boolean;
}

let cached: AppConfig | null = null;

function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  const env = { ...process.env, ...overrides };

  const bluesmindsApiKey = env.BLUESMINDS_API_KEY?.trim() ?? '';
  const bluesmindsBaseUrl = (env.BLUESMINDS_BASE_URL ?? 'https://api.bluesminds.com/v1').replace(/\/+$/, '');

  const port = parseInt10(env.PORT, 8787);
  const defaultModel = env.DEFAULT_MODEL?.trim() || 'gpt-4.1';
  const strictModelMapping = parseBool(env.STRICT_MODEL_MAPPING, false);
  const proxyApiKey = env.PROXY_API_KEY?.trim() ?? '';
  const requestTimeoutMs = parseInt10(env.REQUEST_TIMEOUT_MS, 30000);
  const rateLimitPerMinute = parseInt10(env.RATE_LIMIT_PER_MINUTE, 60);
  const maxBodySize = env.MAX_BODY_SIZE?.trim() || '20mb';
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);
  const debugLogs = parseBool(env.DEBUG_LOGS, false);

  const nodeEnv = (env.NODE_ENV?.toLowerCase() === 'production'
    ? 'production'
    : env.NODE_ENV?.toLowerCase() === 'test'
      ? 'test'
      : 'development') as AppConfig['nodeEnv'];

  const adminPassword = env.ADMIN_PASSWORD?.trim() ?? '';
  const clearLogOnRestart = parseBool(env.CLEAR_LOG_ON_RESTART, false);

  const cfg: AppConfig = {
    bluesmindsApiKey,
    bluesmindsBaseUrl,
    port,
    defaultModel,
    strictModelMapping,
    proxyApiKey,
    requestTimeoutMs,
    rateLimitPerMinute,
    maxBodySize,
    allowedOrigins,
    debugLogs,
    adminPassword,
    nodeEnv,
    version: '1.0.0',
    name: 'Free Claude Code Gateway',
    clearLogOnRestart,
  };

  cached = cfg;
  return cfg;
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  return loadConfig();
}

export function resetConfigCache(): void {
  cached = null;
}
