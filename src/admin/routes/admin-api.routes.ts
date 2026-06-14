import { Router, type Request, type Response } from 'express';
import type { AdminState } from '../admin-state';
import { ConfigValidationError } from '../config-manager';
import { ModelRegistryValidationError } from '../model-registry';
import { ProviderValidationError } from '../provider-manager';
import { getLogger } from '../../utils/logger';
import { execFileSync } from 'node:child_process';
import { buildContextRouter } from './context.routes';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { getConfig } from '../../config/env';

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
  router.post('/models/auto-map', (req: Request, res: Response) => {
    try {
      // Prefer the unsaved UI value sent in the request body so that changing
      // the Default Fallback Model and clicking Auto-Map (before Save Router)
      // correctly uses the new value rather than the last-persisted config value.
      const bodyDefault = (req.body as { defaultModel?: string })?.defaultModel?.trim();
      const defaultModel = bodyDefault || state.configManager.getDefaultModel();
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

  // ── Provider Management ───────────────────────────────────────────────────

  // GET /admin/api/providers — list all providers (keys redacted)
  router.get('/providers', (_req: Request, res: Response) => {
    res.json(state.providerManager.snapshot());
  });

  // POST /admin/api/providers — add a new provider
  router.post('/providers', (req: Request, res: Response) => {
    try {
      const snap = state.providerManager.add(req.body);
      res.status(201).json(snap);
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: err.message } });
        return;
      }
      logger.error({ err }, 'provider_add_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to add provider.' } });
    }
  });

  // PUT /admin/api/providers/:id — update a provider
  router.put('/providers/:id', (req: Request, res: Response) => {
    try {
      const snap = state.providerManager.update(req.params.id, req.body);
      res.json(snap);
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: err.message } });
        return;
      }
      logger.error({ err }, 'provider_update_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to update provider.' } });
    }
  });

  // DELETE /admin/api/providers/:id — delete a provider
  router.delete('/providers/:id', (req: Request, res: Response) => {
    try {
      state.providerManager.delete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: err.message } });
        return;
      }
      logger.error({ err }, 'provider_delete_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to delete provider.' } });
    }
  });

  // POST /admin/api/providers/:id/activate — switch active provider
  router.post('/providers/:id/activate', async (req: Request, res: Response) => {
    try {
      // ── Step 1: save outgoing provider's current Model Router state ──
      const outgoingId = state.providerManager.snapshot().activeId;
      if (outgoingId) {
        const currentSnap = state.modelRegistry.snapshot();
        state.providerManager.saveModelSnapshot(
          outgoingId,
          currentSnap.mappings,
          currentSnap.familyRules,
          currentSnap.default,
        );
        logger.info({ providerId: outgoingId }, 'provider_model_snapshot_saved');
      }

      // ── Step 2: activate the new provider ───────────────────────────
      const payload = state.providerManager.setActive(req.params.id);
      const active = state.providerManager.getActive();

      if (active) {
        // ── Step 3: check if this provider has a saved snapshot ─────────
        const savedSnap = state.providerManager.getModelSnapshot(active.id);

        if (savedSnap) {
          // Restore the previously saved mappings + family rules + default
          logger.info(
            { providerId: active.id, savedAt: savedSnap.savedAt },
            'provider_model_snapshot_restored',
          );
          if (Object.keys(savedSnap.mappings).length > 0) {
            state.modelRegistry.replace({
              mappings: savedSnap.mappings,
              default: savedSnap.defaultModel,
            });
          } else {
            state.modelRegistry.setDefault(savedSnap.defaultModel);
          }
          if (savedSnap.familyRules.length > 0) {
            state.modelRegistry.replaceFamilyRules(savedSnap.familyRules);
          }
          state.configManager.update({ defaultModel: savedSnap.defaultModel });

          res.json({ ...payload, restored: true, restoredFrom: savedSnap.savedAt });
          return;
        }

        // ── Step 4: no saved snapshot — fetch models and auto-map ───────
        if (active.defaultModel) {
          state.configManager.update({ defaultModel: active.defaultModel });
          state.modelRegistry.setDefault(active.defaultModel);
        }

        const fetchAndRemap = async () => {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15_000);
            const r = await fetch(`${active.baseUrl}/models`, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${active.apiKey}`,
              },
              signal: controller.signal,
            });
            clearTimeout(timer);
            if (!r.ok) return;

            const data = await r.json() as { data?: Array<{ id?: string }> };
            const modelIds: string[] = Array.isArray(data?.data)
              ? data.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
              : [];
            if (modelIds.length === 0) return;

            state.modelRegistry.setCachedModels(modelIds);

            const target = modelIds.includes(active.defaultModel)
              ? active.defaultModel
              : modelIds[0];

            const snap = state.modelRegistry.snapshot();
            const newMappings: Record<string, string> = {};
            for (const claudeModel of Object.keys(snap.mappings)) {
              newMappings[claudeModel] = target;
            }
            if (Object.keys(newMappings).length > 0) {
              state.modelRegistry.replace({ mappings: newMappings, default: target });
            } else {
              state.modelRegistry.setDefault(target);
            }

            const updatedRules = snap.familyRules.map((rule) => ({
              name: rule.name,
              pattern: rule.pattern,
              primary: target,
              backup: modelIds.length > 1 && modelIds[1] !== target ? modelIds[1] : undefined,
            }));
            if (updatedRules.length > 0) {
              state.modelRegistry.replaceFamilyRules(updatedRules);
            }

            state.configManager.update({ defaultModel: target });

            logger.info(
              { providerId: active.id, target, modelCount: modelIds.length },
              'provider_activated_mappings_updated',
            );
          } catch (err) {
            logger.warn({ err, providerId: active.id }, 'provider_activate_remap_failed');
          }
        };

        fetchAndRemap();
      }

      res.json({ ...payload, restored: false });
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: err.message } });
        return;
      }
      logger.error({ err }, 'provider_activate_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to activate provider.' } });
    }
  });

  // POST /admin/api/providers/:id/save-snapshot — explicitly save current Model Router state for a provider
  router.post('/providers/:id/save-snapshot', (_req: Request, res: Response) => {
    try {
      const id = _req.params.id;
      if (!state.providerManager.getById(id)) {
        res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: 'Provider not found.' } });
        return;
      }
      const currentSnap = state.modelRegistry.snapshot();
      state.providerManager.saveModelSnapshot(
        id,
        currentSnap.mappings,
        currentSnap.familyRules,
        currentSnap.default,
      );
      res.json({ ok: true, savedAt: new Date().toISOString() });
    } catch (err) {
      logger.error({ err }, 'provider_save_snapshot_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to save snapshot.' } });
    }
  });

  // POST /admin/api/providers/deactivate — clear active provider (use env defaults)
  router.post('/providers/deactivate', (_req: Request, res: Response) => {
    try {
      const payload = state.providerManager.setActive(null);
      res.json(payload);
    } catch (err) {
      logger.error({ err }, 'provider_deactivate_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to deactivate provider.' } });
    }
  });

  // POST /admin/api/providers/:id/test — test a specific provider connection
  router.post('/providers/:id/test', async (req: Request, res: Response) => {
    const provider = state.providerManager.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: 'Provider not found.' } });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const start = Date.now();
    try {
      const testModel = provider.defaultModel || 'gpt-4o-mini';
      const r = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 16,
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (r.ok) {
        const body = parsed as { choices?: Array<{ message?: { content?: string } }> } | null;
        const preview = (body?.choices?.[0]?.message?.content ?? '').slice(0, 200);
        res.json({ success: true, latencyMs, upstreamStatus: r.status, preview });
      } else {
        const errBody = parsed as { error?: { message?: string } } | null;
        const message = errBody?.error?.message ?? `HTTP ${r.status}`;
        res.json({ success: false, latencyMs, upstreamStatus: r.status, error: message });
      }
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      res.json({
        success: false,
        latencyMs,
        upstreamStatus: null,
        error: isAbort ? 'Request timed out after 30s' : (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // POST /admin/api/providers/:id/sync-models — sync models for a specific provider
  router.post('/providers/:id/sync-models', async (req: Request, res: Response) => {
    const provider = state.providerManager.getById(req.params.id);
    if (!provider) {
      res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: 'Provider not found.' } });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const r = await fetch(`${provider.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        signal: controller.signal,
      });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      if (!r.ok) {
        const errBody = parsed as { error?: { message?: string } } | null;
        const errMsg = errBody?.error?.message ?? `Upstream returned status ${r.status}`;
        res.status(502).json({ type: 'error', error: { type: 'api_error', message: errMsg } });
        return;
      }
      const arr = Array.isArray((parsed as { data?: unknown[] })?.data)
        ? (parsed as { data: Array<{ id?: string }> }).data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
        : [];

      const isActive = state.providerManager.snapshot().activeId === provider.id;

      if (isActive && arr.length > 0) {
        // ── Sync into model registry cache ──────────────────────
        state.modelRegistry.setCachedModels(arr);

        // ── Remap all mappings + family rules to this provider ──
        // Pick the target model: prefer the provider's configured defaultModel
        // if it exists in the list, otherwise use the first model.
        const target = arr.includes(provider.defaultModel)
          ? provider.defaultModel
          : arr[0];

        // Update every exact mapping to the target model
        const snap = state.modelRegistry.snapshot();
        const newMappings: Record<string, string> = {};
        for (const claudeModel of Object.keys(snap.mappings)) {
          newMappings[claudeModel] = target;
        }
        if (Object.keys(newMappings).length > 0) {
          state.modelRegistry.replace({ mappings: newMappings, default: target });
        } else {
          state.modelRegistry.setDefault(target);
        }

        // Update family rules — primary = target, backup = second model if available
        const backup = arr.find((m) => m !== target);
        const updatedRules = snap.familyRules.map((rule) => ({
          name: rule.name,
          pattern: rule.pattern,
          primary: target,
          ...(backup ? { backup } : {}),
        }));
        if (updatedRules.length > 0) {
          state.modelRegistry.replaceFamilyRules(updatedRules);
        }

        // Sync default into config
        state.configManager.update({ defaultModel: target });

        logger.info(
          { providerId: provider.id, target, modelCount: arr.length },
          'provider_sync_mappings_updated',
        );

        res.json({
          models: arr,
          syncedAt: new Date().toISOString(),
          remapped: true,
          target,
          updatedMappings: Object.keys(newMappings).length,
        });
      } else {
        // Not active or no models — just cache the list, don't touch mappings
        if (arr.length > 0) {
          state.modelRegistry.setCachedModels(arr);
        }
        res.json({
          models: arr,
          syncedAt: new Date().toISOString(),
          remapped: false,
        });
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      res.status(502).json({
        type: 'error',
        error: { type: 'api_error', message: isAbort ? 'Request timed out' : 'Upstream request failed' },
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // GET /admin/api/events — SSE stream of new request records
  router.get('/events', (req: Request, res: Response) => {    res.setHeader('Content-Type', 'text/event-stream');
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

  // ── Context Management Routes ─────────────────────────────────────────────
  // Mount all /admin/api/context/* endpoints
  router.use('/context', buildContextRouter(state.contextTracker));

  // ── Local Claude Integration ──────────────────────────────────────────────

  function getClaudeJsonPath(): string {
    return nodePath.join(os.homedir(), '.claude.json');
  }

  function readClaudeJson(filePath: string): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // GET /admin/api/claude-local/status
  // Reads ~/.claude.json and reports whether ANTHROPIC_BASE_URL points at this proxy.
  router.get('/claude-local/status', (_req: Request, res: Response) => {
    const filePath = getClaudeJsonPath();
    const proxyPort = getConfig().port;
    const proxyBaseUrl = `http://localhost:${proxyPort}`;

    let fileExists = false;
    let readable = false;
    let currentBaseUrl: string | null = null;
    let currentAuthToken: string | null = null;
    let currentModel: string | null = null;
    let configured = false;
    let partial = false;

    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      fileExists = true;
      readable = true;
      const data = readClaudeJson(filePath);
      const env = (data.env ?? {}) as Record<string, string>;
      currentBaseUrl = env['ANTHROPIC_BASE_URL'] ?? null;
      currentAuthToken = env['ANTHROPIC_AUTH_TOKEN'] ?? null;
      currentModel = env['ANTHROPIC_MODEL'] ?? null;

      if (currentBaseUrl) {
        // Normalise trailing slashes for comparison
        const normCurrent = currentBaseUrl.replace(/\/+$/, '');
        const normProxy = proxyBaseUrl.replace(/\/+$/, '');
        configured = normCurrent === normProxy;
        partial = !configured; // file has a URL but it's different
      }
    } catch {
      // file missing or unreadable
      if (fileExists) readable = false;
    }

    res.json({
      claudeJsonPath: filePath,
      fileExists,
      readable,
      configured,
      partial,
      currentBaseUrl,
      currentAuthToken: currentAuthToken ? '••••' : null,
      currentModel,
      proxyBaseUrl,
    });
  });

  // POST /admin/api/claude-local/configure
  // Merges the proxy env block into ~/.claude.json (creates file if absent).
  router.post('/claude-local/configure', (req: Request, res: Response) => {
    const filePath = getClaudeJsonPath();
    const proxyPort = getConfig().port;
    const proxyBaseUrl = `http://localhost:${proxyPort}`;
    const rawProxyApiKey = state.configManager.getProxyApiKey();
    const authToken = rawProxyApiKey.trim() ? rawProxyApiKey.trim() : 'local-proxy-key';
    const defaultModel = state.configManager.getDefaultModel();

    // Allow caller to override values
    const body = req.body as { authToken?: string; model?: string } | undefined;
    const finalAuthToken = body?.authToken?.trim() || authToken;
    const finalModel = body?.model?.trim() || defaultModel;

    try {
      // Read existing file (or empty object)
      let existing: Record<string, unknown> = {};
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
        existing = readClaudeJson(filePath);
      } catch {
        // file doesn't exist yet — start fresh
      }

      // Deep-merge: preserve all existing top-level keys, only update env sub-keys
      const existingEnv = (existing.env ?? {}) as Record<string, string>;
      const updatedEnv = {
        ...existingEnv,
        ANTHROPIC_BASE_URL: proxyBaseUrl,
        ANTHROPIC_AUTH_TOKEN: finalAuthToken,
        ANTHROPIC_MODEL: finalModel,
      };

      const updated: Record<string, unknown> = {
        ...existing,
        env: updatedEnv,
      };

      // Write atomically via temp file + rename where possible
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmpPath, filePath);

      logger.info({ filePath, proxyBaseUrl, finalModel }, 'claude_local_configured');

      res.json({
        ok: true,
        claudeJsonPath: filePath,
        written: {
          ANTHROPIC_BASE_URL: proxyBaseUrl,
          ANTHROPIC_AUTH_TOKEN: '••••',
          ANTHROPIC_MODEL: finalModel,
        },
      });
    } catch (err) {
      logger.error({ err, filePath }, 'claude_local_configure_failed');
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Failed to write ${filePath}: ${(err as Error).message}`,
        },
      });
    }
  });

  // POST /admin/api/claude-local/open
  // Opens ~/.claude.json in Notepad
  router.post('/claude-local/open', (_req: Request, res: Response) => {
    const filePath = getClaudeJsonPath();
    try {
      const { exec } = require('node:child_process');
      const command = process.platform === 'win32' 
        ? `start notepad "${filePath}"` 
        : `open "${filePath}"`;
        
      exec(command, (error: Error | null) => {
        if (error) {
          logger.error({ err: error, filePath }, 'claude_local_open_failed');
        }
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, filePath }, 'claude_local_open_failed');
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Failed to open ${filePath}: ${(err as Error).message}`,
        },
      });
    }
  });

  return router;
}
