import 'dotenv/config';
import express, { type Application } from 'express';
import * as path from 'node:path';
import { loadConfig } from './config/env';
import { getLogger } from './utils/logger';
import { BluesmindsService } from './services/bluesminds.service';
import { buildHealthRouter } from './routes/health.routes';
import { buildModelsRouter } from './routes/models.routes';
import { buildMessagesRouter } from './routes/messages.routes';
import { buildChatCompletionsRouter } from './routes/chat-completions.routes';
import { authMiddleware } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { buildRateLimiter } from './middleware/rate-limit';
import { buildCors } from './middleware/cors';
import { requestContext, requestLogger } from './middleware/request-logger';
import { AdminState } from './admin/admin-state';
import { buildRequestLogMiddleware } from './admin/request-log-middleware';
import { buildAdminAuth } from './admin/middleware/admin-auth';
import { buildAdminApiRouter } from './admin/routes/admin-api.routes';
import { truncateFile } from './admin/persist';

function createApp(): Application {
  const cfg = loadConfig();
  const app = express();
  const state = new AdminState(cfg.clearLogOnRestart);
  const service = new BluesmindsService({ configManager: state.configManager });

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(buildCors());
  app.use(express.json({ limit: cfg.maxBodySize }));
  app.use(express.urlencoded({ extended: false, limit: cfg.maxBodySize }));
  app.use(requestContext);

  app.use(buildHealthRouter());

  // Admin section: serve static SPA + JSON API behind optional Basic auth.
  const adminAuth = buildAdminAuth({ enabled: cfg.adminPassword.length > 0 });
  const adminApi = buildAdminApiRouter(state);

  // /admin/assets/* — public, no auth, served before auth so CSS/JS load
  // even if Basic auth is required.
  const adminAssetsDir = path.resolve(__dirname, '..', 'public', 'admin');
  app.use('/admin/assets', express.static(adminAssetsDir, { fallthrough: true }));

  // /admin/api/* — requires auth when enabled.
  app.use('/admin/api', adminAuth, adminApi);

  // /admin and /admin/* — SPA fallback (HTML) when not /admin/api/* or /admin/assets/*.
  // Excludes auth-gated routes already handled.
  app.get(/^\/admin(\/.*)?$/, adminAuth, (_req, res, next) => {
    if (_req.path.startsWith('/admin/api') || _req.path.startsWith('/admin/assets')) {
      next();
      return;
    }
    res.sendFile(path.join(adminAssetsDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  // requestLogger must be registered BEFORE apiRouter so it attaches
  // res.on('finish') listeners before route handlers run.
  app.use(requestLogger);

  const apiRouter = express.Router();
  apiRouter.use(buildRateLimiter());
  apiRouter.use(authMiddleware);
  apiRouter.use(buildRequestLogMiddleware(state));
  apiRouter.use(buildModelsRouter(service, state));
  apiRouter.use(buildMessagesRouter(service, state));
  apiRouter.use(buildChatCompletionsRouter(service, state));

  app.use(apiRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function start(): void {
  const cfg = loadConfig();
  const logger = getLogger();

  // ── On-startup cleanup ─────────────────────────────────────────────────────
  if (cfg.clearLogOnRestart) {
    // Truncate pino log files written by the PM2 / ecosystem config so the
    // new session starts with empty files. truncateFile keeps the inode alive
    // so PM2's file descriptor stays valid.
    const root = path.resolve(__dirname, '..');
    truncateFile(path.join(root, 'server.log'));
    truncateFile(path.join(root, 'server-err.log'));
    logger.info('startup_log_cleared: request log, server.log and server-err.log wiped on restart');
  }
  // ──────────────────────────────────────────────────────────────────────────

  const app = createApp();

  if (!cfg.bluesmindsApiKey) {
    logger.warn(
      'BLUESMINDS_API_KEY is not set. Upstream calls will fail until you set it in your environment or .env file.',
    );
  }

  if (cfg.nodeEnv === 'production' && cfg.allowedOrigins.length === 0) {
    logger.warn(
      'ALLOWED_ORIGINS is not set. All browser cross-origin requests will be blocked in production. Set ALLOWED_ORIGINS to a comma-separated list of allowed origins, or "*" to allow all.',
    );
  }

  const server = app.listen(cfg.port, () => {
    logger.info(
      {
        port: cfg.port,
        env: cfg.nodeEnv,
        base_url: cfg.bluesmindsBaseUrl,
        default_model: cfg.defaultModel,
        strict_mapping: cfg.strictModelMapping,
        proxy_api_key_set: Boolean(cfg.proxyApiKey),
        admin_password_set: cfg.adminPassword.length > 0,
        rate_limit_per_min: cfg.rateLimitPerMinute,
        timeout_ms: cfg.requestTimeoutMs,
        clear_log_on_restart: cfg.clearLogOnRestart,
      },
      `${cfg.name} v${cfg.version} listening on http://localhost:${cfg.port}`,
    );
    if (cfg.adminPassword) {
      logger.info(`Admin dashboard: http://localhost:${cfg.port}/admin (HTTP Basic auth enabled)`);
    } else {
      logger.info(`Admin dashboard: http://localhost:${cfg.port}/admin (no auth — set ADMIN_PASSWORD to lock down)`);
    }
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutdown_signal_received');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'shutdown_error');
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled_rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught_exception');
    process.exit(1);
  });
}

start();
