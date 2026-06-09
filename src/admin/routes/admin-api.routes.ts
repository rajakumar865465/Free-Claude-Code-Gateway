import { Router, type Request, type Response } from 'express';
import type { AdminState } from '../admin-state';
import { ConfigValidationError } from '../config-manager';
import { ModelRegistryValidationError } from '../model-registry';
import { getLogger } from '../../utils/logger';
import { execFileSync } from 'node:child_process';

function detectProcessManager(): { manager: string; appName: string } {
  const pm2Name = process.env.PM2_APP_NAME;
  if (pm2Name) return { manager: 'pm2', appName: pm2Name };
  if (process.env.DOCKER_CONTAINER || process.env.KUBERNETES_SERVICE_HOST) {
    return { manager: 'docker', appName: '' };
  }
  if (process.env.PROCESS_MANAGER) {
    return { manager: process.env.PROCESS_MANAGER, appName: pm2Name || '' };
  }
  return { manager: 'node', appName: '' };
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function scheduleGatewayRestart(proc: { manager: string; appName: string }, logger: ReturnType<typeof getLogger>) {
  // Respond first, then restart after delay
  setTimeout(() => {
    try {
      if (proc.manager === 'pm2' && proc.appName) {
        logger.info({ appName: proc.appName }, 'restarting_via_pm2');
        // Use execFileSync (not execSync) to avoid shell injection via appName
        execFileSync('pm2', ['restart', proc.appName], { timeout: 10_000 });
      } else if (proc.manager === 'docker') {
        logger.info('restart_requires_docker_host');
        // Cannot restart from inside container — log guidance
      } else {
        logger.info('restart_no_process_manager');
        // Exit with code 0 — requires external supervisor to restart
        if (process.env.ALLOW_SELF_RESTART === 'true') {
          process.exit(0);
        }
      }
    } catch (err) {
      logger.error({ err }, 'restart_failed');
    }
  }, 500);
}

export function buildAdminApiRouter(state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  // GET /admin/api/requests — paginated request log
  router.get('/requests', (_req: Request, res: Response) => {
    res.json({ requests: state.requestLog.latestFirst() });
  });

  // GET /admin/api/stats — overall + per-model aggregations
  router.get('/stats', (_req: Request, res: Response) => {
    res.json(state.statsEngine.compute());
  });

  // GET /admin/api/config — current runtime config (no API key)
  router.get('/config', (_req: Request, res: Response) => {
    res.json(state.configManager.snapshot());
  });

  // PUT /admin/api/config — partial config update with validation
  router.put('/config', (req: Request, res: Response) => {
    try {
      const updated = state.configManager.update(req.body);

      // Sync pricing to StatsEngine for cost calculations
      state.statsEngine.setPrices(
        state.configManager.getInputPricePerMillion(),
        state.configManager.getOutputPricePerMillion(),
      );

      // Option A: apply config changes + auto-restart when middleware needs it (e.g. maxBodySize).
      if (updated.restartRequired) {
        const proc = detectProcessManager();
        logger.info({ manager: proc.manager, appName: proc.appName, restartReasons: updated.restartReasons }, 'auto_restart_scheduled');

        // Respond first, then restart after delay.
        res.json({
          ...updated,
          restartScheduled: true,
          restartManager: proc.manager,
          restartAppName: proc.appName,
        });

        scheduleGatewayRestart(proc, logger);
        return;
      }

      res.json(updated);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: err.message },
        });
        return;
      }
      logger.error({ err }, 'config_update_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to update config.' },
      });
    }
  });

  // POST /admin/api/stats/clear — wipe in-memory request log
  router.post('/stats/clear', (_req: Request, res: Response) => {
    state.requestLog.clear();
    res.json({ ok: true });
  });

  // GET /admin/api/models/mappings
  router.get('/models/mappings', (_req: Request, res: Response) => {
    res.json(state.modelRegistry.snapshot());
  });

  // PUT /admin/api/models/mappings — replace exact mappings (+ optional default)
  router.put('/models/mappings', (req: Request, res: Response) => {
    try {
      const updated = state.modelRegistry.replace(req.body);
      res.json(updated);
    } catch (err) {
      if (err instanceof ModelRegistryValidationError) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: err.message },
        });
        return;
      }
      logger.error({ err }, 'model_mappings_update_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to update model mappings.' },
      });
    }
  });

  // PUT /admin/api/models/default — update the default fallback model
  router.put('/models/default', (req: Request, res: Response) => {
    try {
      const body = req.body as { default?: unknown };
      if (typeof body?.default !== 'string' || !body.default.trim()) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'default must be a non-empty string.' },
        });
        return;
      }
      const updated = state.modelRegistry.setDefault(body.default);
      // Also sync the default into ConfigManager so /v1/messages fallback is consistent
      state.configManager.update({ defaultModel: body.default.trim() });
      res.json(updated);
    } catch (err) {
      if (err instanceof ModelRegistryValidationError) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: (err as Error).message },
        });
        return;
      }
      logger.error({ err }, 'model_default_update_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to update default model.' },
      });
    }
  });

  // GET /admin/api/models/family-rules — return current family routing rules
  router.get('/models/family-rules', (_req: Request, res: Response) => {
    const snap = state.modelRegistry.snapshot();
    res.json({ familyRules: snap.familyRules });
  });

  // PUT /admin/api/models/family-rules — replace all family routing rules
  router.put('/models/family-rules', (req: Request, res: Response) => {
    try {
      const updated = state.modelRegistry.replaceFamilyRules(req.body);
      res.json(updated);
    } catch (err) {
      if (err instanceof ModelRegistryValidationError) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: (err as Error).message },
        });
        return;
      }
      logger.error({ err }, 'family_rules_update_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to update family routing rules.' },
      });
    }
  });

  // GET /admin/api/models/available — proxy to upstream /v1/models
  router.get('/models/available', async (_req: Request, res: Response) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const url = `${state.configManager.getBaseUrl()}/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      const key = state.configManager.getApiKey();
      if (key) headers.Authorization = `Bearer ${key}`;
      const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const text = await r.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!r.ok) {
        res.status(502).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Upstream returned status ${r.status}: ${text.slice(0, 200)}`,
          },
        });
        return;
      }
      const arr = Array.isArray((parsed as { data?: unknown[] })?.data)
        ? (parsed as { data: Array<{ id?: string }> }).data
            .map((m) => m.id)
            .filter((id): id is string => typeof id === 'string')
        : [];
      state.modelRegistry.setCachedModels(arr);
      res.json({ models: arr, syncedAt: new Date().toISOString() });
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      res.status(502).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: isAbort ? 'Upstream request exceeded 10s timeout' : 'Upstream request failed',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // POST /admin/api/models/auto-map — compute suggestions from cached model list
  router.post('/models/auto-map', (_req: Request, res: Response) => {
    try {
      const defaultModel = state.configManager.getDefaultModel();
      const result = state.modelRegistry.computeAutoMap(defaultModel);
      res.json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('No models synced')) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: err.message },
        });
        return;
      }
      logger.error({ err }, 'auto_map_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Auto-map failed.' },
      });
    }
  });

  // POST /admin/api/models/apply-suggestions — apply cached suggestions
  router.post('/models/apply-suggestions', (req: Request, res: Response) => {
    try {
      const body = req.body as { acceptAll?: boolean; accept?: string[] };
      const accept: string[] | 'all' = body.acceptAll === true ? 'all' : (body.accept ?? []);
      const defaultModel = state.configManager.getDefaultModel();
      const updated = state.modelRegistry.applySuggestions(accept, defaultModel);
      res.json(updated);
    } catch (err) {
      if (err instanceof ModelRegistryValidationError) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: (err as Error).message },
        });
        return;
      }
      logger.error({ err }, 'apply_suggestions_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Apply suggestions failed.' },
      });
    }
  });

  // POST /admin/api/test-connection
  router.post('/test-connection', async (_req: Request, res: Response) => {
    const result = await state.connectionTester.run();
    res.json(result);
  });

  // POST /admin/api/sync-models — fetch upstream models and return them
  router.post('/sync-models', async (_req: Request, res: Response) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const url = `${state.configManager.getBaseUrl()}/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      const key = state.configManager.getApiKey();
      if (key) headers.Authorization = `Bearer ${key}`;
      const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const text = await r.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!r.ok) {
        const errBody = parsed as { error?: { message?: string } } | null;
        const errMsg = errBody?.error?.message ?? `Upstream returned status ${r.status}`;
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: errMsg },
        });
        return;
      }
      const arr = Array.isArray((parsed as { data?: unknown[] })?.data)
        ? (parsed as { data: Array<{ id?: string }> }).data
            .map((m) => m.id)
            .filter((id): id is string => typeof id === 'string')
        : [];
      state.modelRegistry.setCachedModels(arr);
      res.json({ models: arr, syncedAt: new Date().toISOString() });
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError');
      res.status(502).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: isAbort ? 'Upstream request exceeded 15s timeout' : 'Upstream request failed',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // GET /admin/api/operations — gateway operational status
  router.get('/operations', (_req: Request, res: Response) => {
    const proc = detectProcessManager();
    const uptime = process.uptime();
    res.json({
      ok: true,
      processManager: proc.manager,
      pm2AppName: proc.appName,
      restartRequired: state.configManager.restartRequired,
      restartReasons: state.configManager.restartReasons,
      uptimeMs: Math.round(uptime * 1000),
      uptimeFormatted: formatUptime(uptime),
      nodeVersion: process.version,
      pid: process.pid,
    });
  });

  // POST /admin/api/restart — safely restart the gateway
  router.post('/restart', async (_req: Request, res: Response) => {
    const proc = detectProcessManager();
    logger.info({ manager: proc.manager, appName: proc.appName }, 'restart_requested');

    // Respond first, then restart after delay
    res.json({ ok: true, message: 'Restart scheduled', manager: proc.manager });

    scheduleGatewayRestart(proc, logger);
  });

  // GET /admin/api/events — SSE stream of new request records
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send({ type: 'hello', ts: Date.now() });

    const unsubscribe = state.requestLog.subscribe((entry) => {
      send({ type: 'request', entry });
    });

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);

    // Guard: both req.close and res.close can fire for the same disconnect.
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  return router;
}
