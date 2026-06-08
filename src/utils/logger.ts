import pino, { type Logger } from 'pino';
import { getConfig } from '../config/env';

let cachedLogger: Logger | null = null;

export function getLogger(): Logger {
  if (cachedLogger) return cachedLogger;
  const cfg = getConfig();
  const isDev = cfg.nodeEnv !== 'production';
  cachedLogger = pino({
    level: cfg.debugLogs ? 'debug' : isDev ? 'info' : 'info',
    base: { service: cfg.name, version: cfg.version },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["api-key"]',
        'res.headers["x-api-key"]',
        'authorization',
        'apiKey',
        'api_key',
        'BLUESMINDS_API_KEY',
      ],
      censor: '[REDACTED]',
    },
    transport: isDev
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service,version',
            singleLine: false,
          },
        }
      : undefined,
  });
  return cachedLogger;
}

export function setLogger(logger: Logger): void {
  cachedLogger = logger;
}

export function setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
  const logger = getLogger();
  logger.level = level;
}

export function resetLogger(): void {
  cachedLogger = null;
}
