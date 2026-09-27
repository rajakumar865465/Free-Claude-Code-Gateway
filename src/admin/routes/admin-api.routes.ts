import { Router, type Request, type Response } from 'express';
import type { AdminState } from '../admin-state';
import { ConfigValidationError } from '../config-manager';
import { ModelRegistryValidationError } from '../model-registry';
import { ProviderValidationError, DATABRICKS_BASE_URL, type Provider } from '../provider-manager';
import { getLogger } from '../../utils/logger';
import { execFileSync } from 'node:child_process';
import { buildContextRouter } from './context.routes';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { getConfig } from '../../config/env';
import type { FailoverConfig } from '../../provider-failover/types';
import { distributeModelsByTier, matchModelByTier } from '../model-matcher';

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
    const snap = state.modelRegistry.snapshot();
    const cached = state.modelRegistry.getCachedModels();
    const activeProvider = state.providerManager.getActive();
    const allProviders = state.providerManager.getAll();
    res.json({
      ...snap,
      cachedModels: cached.models,
      cachedAt: cached.cachedAt,
      activeProvider: activeProvider
        ? {
            id: activeProvider.id,
            name: activeProvider.name,
            defaultModel: activeProvider.defaultModel,
            models: activeProvider.models || (activeProvider.defaultModel ? [activeProvider.defaultModel] : []),
          }
        : null,
      providerModels: allProviders.map((p) => ({
        id: p.id,
        name: p.name,
        defaultModel: p.defaultModel,
        models: p.models || (p.defaultModel ? [p.defaultModel] : []),
      })),
    });
  });

  // Helper: persist current model mappings into the active provider's snapshot
  function syncActiveProviderSnapshot(): void {
    const active = state.providerManager.getActive();
    if (active) {
      const snap = state.modelRegistry.snapshot();
      state.providerManager.saveModelSnapshot(
        active.id,
        snap.mappings,
        snap.familyRules,
        snap.default,
      );
    }
  }

  // Helper: given a versioned model key like 'claude-3-7-sonnet-20250219',
  // return the unversioned alias 'claude-3-7-sonnet' if it differs from the key.
  function getUnversionedAlias(key: string): string | null {
    // Strip trailing date-like suffixes: -YYYYMMDD or -YYYYMMDD-vN
    const stripped = key.replace(/-\d{8}(-v\d+)?$/, '');
    // Also strip -latest, -preview, -early
    const bare = stripped.replace(/-(latest|preview|early)$/, '');
    return bare !== key ? bare : null;
  }

  // Helper: inject unversioned aliases for all versioned mapping keys
  function injectUnversionedAliases(mappings: Record<string, string>): Record<string, string> {
    const result = { ...mappings };
    for (const [key, val] of Object.entries(mappings)) {
      const alias = getUnversionedAlias(key);
      // Only add alias if it doesn't already exist (don't overwrite explicit user entries)
      if (alias && !(alias in result)) {
        result[alias] = val;
      }
    }
    return result;
  }

  // PUT /admin/api/models/mappings — replace exact mappings (+ optional default)
  router.put('/models/mappings', (req: Request, res: Response) => {
    try {
      // Auto-inject unversioned aliases before saving
      const body = req.body as Record<string, unknown>;
      if (body && typeof body.mappings === 'object' && body.mappings !== null && !Array.isArray(body.mappings)) {
        body.mappings = injectUnversionedAliases(body.mappings as Record<string, string>);
      }
      const updated = state.modelRegistry.replace(body);
      syncActiveProviderSnapshot();
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
      syncActiveProviderSnapshot();
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
      syncActiveProviderSnapshot();
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
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      // Check if active provider is Databricks or AWS Bedrock
      const activeProvider = state.providerManager.getActive();
      if (activeProvider?.type === 'databricks') {
        res.json({
          models: [],
          syncedAt: new Date().toISOString(),
          message: 'Databricks does not expose a models list endpoint. Enter your model ID manually (e.g., system.ai.glm-5-2)'
        });
        return;
      }
      if (activeProvider?.type === 'aws_bedrock') {
        res.json({
          models: [],
          syncedAt: new Date().toISOString(),
          message: 'AWS Bedrock does not expose a models list endpoint. Enter your model ID manually (e.g., anthropic.claude-3-5-sonnet-20241022-v2:0)'
        });
        return;
      }

      const baseUrl = activeProvider?.baseUrl ? activeProvider.baseUrl.replace(/\/+$/, '') : state.configManager.getBaseUrl();
      const url = `${baseUrl}/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      const key = activeProvider?.apiKey || state.configManager.getApiKey();
      if (key) {
        headers.Authorization = `Bearer ${key}`;
        headers['api-key'] = key;
      }
      const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const text = await r.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!r.ok) {
        // If upstream /models failed, but active provider already has saved models, use them
        if (activeProvider?.models && activeProvider.models.length > 0) {
          state.modelRegistry.setCachedModels(activeProvider.models);
          res.json({ models: activeProvider.models, syncedAt: new Date().toISOString() });
          return;
        }
        res.status(502).json({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Upstream returned status ${r.status}: ${text.slice(0, 200)}`,
          },
        });
        return;
      }
      let arr = Array.isArray((parsed as { data?: unknown[] })?.data)
        ? (parsed as { data: Array<{ id?: string }> }).data
            .map((m) => m.id)
            .filter((id): id is string => typeof id === 'string')
        : [];
      if (arr.length === 0 && activeProvider?.models && activeProvider.models.length > 0) {
        arr = activeProvider.models;
      }
      state.modelRegistry.setCachedModels(arr);
      if (activeProvider && arr.length > 0) {
        state.providerManager.setProviderModels(activeProvider.id, arr);
      }
      res.json({ models: arr, syncedAt: new Date().toISOString() });
    } catch (err) {
      const activeProvider = state.providerManager.getActive();
      if (activeProvider?.models && activeProvider.models.length > 0) {
        state.modelRegistry.setCachedModels(activeProvider.models);
        res.json({ models: activeProvider.models, syncedAt: new Date().toISOString() });
        return;
      }
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

  // POST /admin/api/models/smart-tier-match — distribute models across tiers
  router.post('/models/smart-tier-match', (req: Request, res: Response) => {
    try {
      const snap = state.modelRegistry.snapshot();
      const cached = state.modelRegistry.getCachedModels();
      const models = (req.body as { models?: string[] })?.models || cached.models;
      if (!models || models.length === 0) {
        res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'No provider models synced yet. Sync models first.' },
        });
        return;
      }
      const claudeKeys = Object.keys(snap.mappings).length > 0
        ? Object.keys(snap.mappings)
        : [
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
          ];
      const defaultModel = (req.body as { defaultModel?: string })?.defaultModel?.trim() || snap.default || models[0];
      const newMappings = distributeModelsByTier(claudeKeys, models, defaultModel);
      res.json({
        mappings: newMappings,
        default: defaultModel,
      });
    } catch (err) {
      logger.error({ err }, 'smart_tier_match_failed');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to compute smart tier match.' },
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
      syncActiveProviderSnapshot();
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
      // Check if active provider is Databricks
      const activeProvider = state.providerManager.getActive();
      if (activeProvider?.type === 'databricks') {
        // Databricks doesn't reliably support /models endpoint
        // Return empty array or a hint message
        res.json({
          models: [],
          syncedAt: new Date().toISOString(),
          message: 'Databricks does not expose a models list endpoint. Enter your model ID manually (e.g., system.ai.glm-5-2)'
        });
        return;
      }

      // AWS Bedrock doesn't support /models endpoint
      if (activeProvider?.type === 'aws_bedrock') {
        res.json({
          models: [],
          syncedAt: new Date().toISOString(),
          message: 'AWS Bedrock does not expose a models list endpoint. Enter your model ID manually (e.g., anthropic.claude-3-5-sonnet-20241022-v2:0)'
        });
        return;
      }

      const baseUrl = activeProvider?.baseUrl ? activeProvider.baseUrl.replace(/\/+$/, '') : state.configManager.getBaseUrl();
      const url = `${baseUrl}/models`;
      const headers: Record<string, string> = { Accept: 'application/json' };
      const key = activeProvider?.apiKey || state.configManager.getApiKey();
      if (key) {
        headers.Authorization = `Bearer ${key}`;
        headers['api-key'] = key;
      }
      const r = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const text = await r.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      if (!r.ok) {
        if (activeProvider?.models && activeProvider.models.length > 0) {
          state.modelRegistry.setCachedModels(activeProvider.models);
          res.json({ models: activeProvider.models, syncedAt: new Date().toISOString() });
          return;
        }
        const errBody = parsed as { error?: { message?: string } } | null;
        const errMsg = errBody?.error?.message ?? `Upstream returned status ${r.status}`;
        res.status(502).json({
          type: 'error',
          error: { type: 'api_error', message: errMsg },
        });
        return;
      }
      let arr = Array.isArray((parsed as { data?: unknown[] })?.data)
        ? (parsed as { data: Array<{ id?: string }> }).data
            .map((m) => m.id)
            .filter((id): id is string => typeof id === 'string')
        : [];
      if (arr.length === 0 && activeProvider?.models && activeProvider.models.length > 0) {
        arr = activeProvider.models;
      }
      state.modelRegistry.setCachedModels(arr);
      if (activeProvider && arr.length > 0) {
        state.providerManager.setProviderModels(activeProvider.id, arr);
      }
      res.json({ models: arr, syncedAt: new Date().toISOString() });
    } catch (err) {
      const activeProvider = state.providerManager.getActive();
      if (activeProvider?.models && activeProvider.models.length > 0) {
        state.modelRegistry.setCachedModels(activeProvider.models);
        res.json({ models: activeProvider.models, syncedAt: new Date().toISOString() });
        return;
      }
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

  // ── Helper: Remap Model Router to target model and save snapshot ─────────
  function applyModelRemapping(
    target: string,
    modelIds: string[],
    providerId: string,
  ): Record<string, string> {
    const snap = state.modelRegistry.snapshot();
    const existingSnap = state.providerManager.getModelSnapshot(providerId);

    // If this provider ALREADY has a snapshot with distinct mappings, DO NOT overwrite them all!
    if (existingSnap && Object.keys(existingSnap.mappings).length > 0) {
      const distinct = new Set(Object.values(existingSnap.mappings));
      if (distinct.size > 1) {
        state.modelRegistry.replace({
          mappings: existingSnap.mappings,
          default: target || existingSnap.defaultModel,
        });
        if (existingSnap.familyRules && existingSnap.familyRules.length > 0) {
          state.modelRegistry.replaceFamilyRules(existingSnap.familyRules);
        }
        state.configManager.update({ defaultModel: target || existingSnap.defaultModel });
        return existingSnap.mappings;
      }
    }

    const prov = state.providerManager.getById(providerId);
    const effectiveModelIds = modelIds.length > 0
      ? modelIds
      : (prov?.models && prov.models.length > 0 ? prov.models : []);

    const claudeKeys = Object.keys(snap.mappings);
    const newMappings: Record<string, string> = effectiveModelIds.length > 1
      ? distributeModelsByTier(claudeKeys, effectiveModelIds, target)
      : {};
    if (effectiveModelIds.length <= 1) {
      for (const claudeModel of claudeKeys) {
        newMappings[claudeModel] = target;
      }
    }
    if (Object.keys(newMappings).length > 0) {
      state.modelRegistry.replace({ mappings: newMappings, default: target });
    } else {
      state.modelRegistry.setDefault(target);
    }

    const backup = effectiveModelIds.find((m) => m !== target);
    const updatedRules = snap.familyRules.map((rule) => {
      let primary = target;
      if (effectiveModelIds.length > 1) {
        const nameLower = (rule.name + ' ' + rule.pattern).toLowerCase();
        if (nameLower.includes('haiku')) {
          primary = matchModelByTier('haiku', effectiveModelIds, target);
        } else if (nameLower.includes('opus')) {
          primary = matchModelByTier('opus', effectiveModelIds, target);
        } else if (nameLower.includes('sonnet')) {
          primary = matchModelByTier('sonnet', effectiveModelIds, target);
        }
      }
      return {
        name: rule.name,
        pattern: rule.pattern,
        primary,
        ...(backup ? { backup } : {}),
      };
    });
    if (updatedRules.length > 0) {
      state.modelRegistry.replaceFamilyRules(updatedRules);
    }

    state.configManager.update({ defaultModel: target });

    state.providerManager.saveModelSnapshot(
      providerId,
      newMappings,
      updatedRules,
      target,
    );

    return newMappings;
  }

  // ── Helper: Sync models from provider and remap router ────────────────────
  async function executeModelSyncAndRemap(
    provider: Provider,
    remapRouter: boolean = true,
  ): Promise<{
    models: string[];
    remapped: boolean;
    target: string;
    message?: string;
    error?: string;
    updatedMappings?: number;
  }> {
    if (provider.type === 'databricks') {
      const target = provider.defaultModel || '';
      let updatedMappings = 0;
      if (remapRouter && target) {
        const mapped = applyModelRemapping(target, [], provider.id);
        updatedMappings = Object.keys(mapped).length;
      }
      return {
        models: [],
        remapped: remapRouter && Boolean(target),
        target,
        updatedMappings,
        message: 'Databricks does not expose a models list endpoint. Enter your model ID manually (e.g., system.ai.glm-5-2)',
      };
    }

    if (provider.type === 'aws_bedrock') {
      const target = provider.defaultModel || '';
      let updatedMappings = 0;
      if (remapRouter && target) {
        const mapped = applyModelRemapping(target, [], provider.id);
        updatedMappings = Object.keys(mapped).length;
      }
      return {
        models: [],
        remapped: remapRouter && Boolean(target),
        target,
        updatedMappings,
        message: 'AWS Bedrock does not expose a models list endpoint. Enter your model ID manually (e.g., anthropic.claude-3-5-sonnet-20241022-v2:0)',
      };
    }

    let arr: string[] = [];
    let fetchError: string | undefined;

    if (provider.baseUrl) {
      let azureNormalizedBase = provider.baseUrl.replace(/\/+$/, '');
      if (provider.type === 'azure_foundry') {
        const suffixesToStrip = [
          '/chat/completions', '/completions', '/embeddings', '/responses',
        ];
        let stripped = true;
        while (stripped) {
          stripped = false;
          for (const s of suffixesToStrip) {
            if (azureNormalizedBase.endsWith(s)) {
              azureNormalizedBase = azureNormalizedBase.slice(0, -s.length);
              stripped = true;
              break;
            }
          }
        }
      }

      const modelsUrl = provider.type === 'azure_foundry'
        ? (azureNormalizedBase.endsWith('/models')
            ? `${azureNormalizedBase}?api-version=${provider.azureApiVersion || '2024-05-01-preview'}`
            : `${azureNormalizedBase}/models?api-version=${provider.azureApiVersion || '2024-05-01-preview'}`)
        : `${provider.baseUrl.replace(/\/+$/, '')}/models`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const r = await fetch(modelsUrl, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${provider.apiKey}`,
            'api-key': provider.apiKey,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await r.text();
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }
        if (r.ok) {
          arr = Array.isArray((parsed as { data?: unknown[] })?.data)
            ? (parsed as { data: Array<{ id?: string }> }).data
                .map((m) => m.id)
                .filter((id): id is string => typeof id === 'string')
            : [];
        } else {
          const errBody = parsed as { error?: { message?: string } } | null;
          fetchError = errBody?.error?.message ?? `Upstream returned status ${r.status}`;
        }
      } catch (err) {
        clearTimeout(timer);
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          (err instanceof DOMException && err.name === 'AbortError');
        fetchError = isAbort ? 'Request timed out' : 'Upstream request failed';
      }
    }

    if (arr.length > 0) {
      state.modelRegistry.setCachedModels(arr);
      state.providerManager.setProviderModels(provider.id, arr);
    } else if (provider.models && provider.models.length > 0) {
      arr = provider.models;
      state.modelRegistry.setCachedModels(arr);
    }

    const target = (arr.length > 0 && arr.includes(provider.defaultModel))
      ? provider.defaultModel
      : (provider.defaultModel || (arr.length > 0 ? arr[0] : ''));

    if (remapRouter && target) {
      const mapped = applyModelRemapping(target, arr, provider.id);
      logger.info(
        { providerId: provider.id, target, modelCount: arr.length },
        'provider_sync_mappings_updated',
      );
      return {
        models: arr,
        remapped: true,
        target,
        updatedMappings: Object.keys(mapped).length,
        error: fetchError,
      };
    }

    // Inactive provider: update its snapshot with the target model
    if (target && !remapRouter) {
      const existingSnap = state.providerManager.getModelSnapshot(provider.id);
      const snapMappings = existingSnap ? { ...existingSnap.mappings } : {};
      for (const k of Object.keys(state.modelRegistry.snapshot().mappings)) {
        snapMappings[k] = target;
      }
      const backup = arr.find((m) => m !== target);
      const rules = state.modelRegistry.snapshot().familyRules.map((rule) => ({
        name: rule.name,
        pattern: rule.pattern,
        primary: target,
        ...(backup ? { backup } : {}),
      }));
      state.providerManager.saveModelSnapshot(provider.id, snapMappings, rules, target);
    }

    return {
      models: arr,
      remapped: false,
      target,
      error: fetchError,
    };
  }

  // PUT /admin/api/providers/:id — update a provider
  router.put('/providers/:id', async (req: Request, res: Response) => {
    try {
      const snap = state.providerManager.update(req.params.id, req.body);
      
      const activeId = state.providerManager.snapshot().activeId;
      const isCurrentlyActive = activeId === req.params.id;
      const updatedProvider = state.providerManager.getById(req.params.id);

      if (updatedProvider) {
        if (isCurrentlyActive) {
          // If active provider's default model was updated, immediately re-sync & remap router!
          await executeModelSyncAndRemap(updatedProvider, true);
        } else {
          // If inactive provider, update its saved snapshot's defaultModel and mappings
          const existingSnap = state.providerManager.getModelSnapshot(req.params.id);
          if (existingSnap) {
            const newMappings: Record<string, string> = {};
            for (const k of Object.keys(existingSnap.mappings)) {
              newMappings[k] = updatedProvider.defaultModel;
            }
            const newRules = existingSnap.familyRules.map((r) => ({
              ...r,
              primary: updatedProvider.defaultModel,
            }));
            state.providerManager.saveModelSnapshot(
              req.params.id,
              newMappings,
              newRules,
              updatedProvider.defaultModel,
            );
          }
        }
      }

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
        // ── Step 3: check if this provider has a saved snapshot ──
        const savedSnap = state.providerManager.getModelSnapshot(active.id);

        if (
          savedSnap &&
          Object.keys(savedSnap.mappings).length > 0
        ) {
          logger.info(
            { providerId: active.id, savedAt: savedSnap.savedAt },
            'provider_model_snapshot_restored',
          );
          state.modelRegistry.replace({
            mappings: savedSnap.mappings,
            default: active.defaultModel || savedSnap.defaultModel,
          });
          if (savedSnap.familyRules.length > 0) {
            state.modelRegistry.replaceFamilyRules(savedSnap.familyRules);
          }
          state.configManager.update({ defaultModel: active.defaultModel || savedSnap.defaultModel });

          if (!active.models || active.models.length <= 1) {
            executeModelSyncAndRemap(active, false).catch((err) => {
              logger.warn({ err, providerId: active.id }, 'auto_sync_on_activate_failed');
            });
          }

          res.json({
            ...payload,
            restored: true,
            remapped: true,
            target: active.defaultModel || savedSnap.defaultModel,
            restoredFrom: savedSnap.savedAt,
          });
          return;
        }

        // ── Step 4: No matching snapshot or model changed — sync and remap automatically ──
        const syncResult = await executeModelSyncAndRemap(active, true);
        res.json({
          ...payload,
          restored: false,
          remapped: syncResult.remapped,
          target: syncResult.target,
          models: syncResult.models,
        });
        return;
      }

      res.json({ ...payload, restored: false, remapped: false });
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
    
    // For AWS Bedrock and other providers, use standard HTTP test
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const start = Date.now();
    try {
      const testModel = provider.defaultModel || 'gpt-4o-mini';
      // Construct base URL based on provider type
      let baseUrl: string;
      let chatUrl: string;
      if (provider.type === 'databricks') {
        baseUrl = DATABRICKS_BASE_URL;
        chatUrl = `${baseUrl}/chat/completions`;
      } else if (provider.type === 'aws_bedrock') {
        const { getBedrockBaseUrl } = await import('../../utils/bedrock-url');
        baseUrl = getBedrockBaseUrl(provider.awsRegion || '');
        chatUrl = `${baseUrl}/chat/completions`;
      } else if (provider.type === 'azure_foundry') {
        // Azure AI Foundry: use the saved baseUrl exactly as it was resolved by the frontend,
        // only stripping actual endpoint suffixes if the user accidentally pasted them.
        const apiVersion = provider.azureApiVersion || '2024-05-01-preview';
        const isResponses = provider.azureApiFlavor === 'responses';
        const raw = (provider.baseUrl || '').replace(/\/+$/, '');
        const suffixesToStrip = [
          '/chat/completions', '/completions', '/embeddings', '/responses'
        ];
        let resourceBase = raw;
        let stripped = true;
        while (stripped) {
          stripped = false;
          for (const s of suffixesToStrip) {
            if (resourceBase.endsWith(s)) {
              resourceBase = resourceBase.slice(0, -s.length);
              stripped = true;
              break;
            }
          }
        }
        baseUrl = resourceBase;
        if (isResponses) {
          if (!baseUrl.includes('/openai') && !baseUrl.includes('/v1')) {
            baseUrl = `${baseUrl}/openai/v1`;
          }
          chatUrl = `${baseUrl}/responses`;
        } else {
          chatUrl = `${baseUrl}/chat/completions?api-version=${apiVersion}`;
        }
      } else {
        baseUrl = provider.baseUrl;
        chatUrl = `${baseUrl}/chat/completions`;
      }
      
      const r = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          'api-key': provider.apiKey,
        },
        body: JSON.stringify(provider.type === 'azure_foundry' && provider.azureApiFlavor === 'responses' ? {
          model: testModel,
          input: 'Hello',
        } : {
          model: testModel,
          messages: [{ role: 'user', content: 'Hello' }],
          max_completion_tokens: 16,
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

    try {
      const isActive = state.providerManager.snapshot().activeId === provider.id;
      const result = await executeModelSyncAndRemap(provider, isActive);

      if (result.error && result.models.length === 0 && !result.target) {
        res.status(502).json({ type: 'error', error: { type: 'api_error', message: result.error } });
        return;
      }

      res.json({
        models: result.models,
        syncedAt: new Date().toISOString(),
        remapped: result.remapped,
        target: result.target,
        updatedMappings: result.updatedMappings,
        message: result.message,
      });
    } catch (err) {
      logger.error({ err, providerId: provider.id }, 'provider_sync_models_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to sync models.' } });
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

  // ── Provider Failover ─────────────────────────────────────────────────────

  // GET /admin/api/failover/status — all provider statuses + summary
  router.get('/failover/status', (_req: Request, res: Response) => {
    try {
      const statuses = state.failoverEngine.getStatuses();
      const config = state.failoverEngine.getConfig();
      const healthyCount = statuses.filter((s) => s.status === 'HEALTHY').length;
      res.json({
        statuses,
        config,
        summary: {
          healthyCount,
          totalCount: statuses.length,
          switchesToday: state.failoverEngine.getTodaySwitchCount(),
          failoverEnabled: config.failover_enabled,
        },
      });
    } catch (err) {
      logger.error({ err }, 'failover_status_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to get failover status.' } });
    }
  });

  // GET /admin/api/failover/switches?page=1 — paginated switch log
  router.get('/failover/switches', (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
      res.json(state.failoverEngine.getSwitchLog(page));
    } catch (err) {
      logger.error({ err }, 'failover_switches_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to get switch log.' } });
    }
  });

  // PATCH /admin/api/failover/config — update failover config
  router.patch('/failover/config', (req: Request, res: Response) => {
    try {
      state.failoverEngine.updateConfig(req.body as Partial<FailoverConfig>);
      res.json({ ok: true, config: state.failoverEngine.getConfig() });
    } catch (err) {
      logger.error({ err }, 'failover_config_update_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to update failover config.' } });
    }
  });

  // POST /admin/api/failover/toggle — enable or disable failover
  router.post('/failover/toggle', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body as { enabled?: unknown };
      state.failoverEngine.toggleFailover(Boolean(enabled));
      res.json({ ok: true, failover_enabled: Boolean(enabled) });
    } catch (err) {
      logger.error({ err }, 'failover_toggle_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to toggle failover.' } });
    }
  });

  // POST /admin/api/failover/health-check — trigger immediate health check
  router.post('/failover/health-check', async (_req: Request, res: Response) => {
    try {
      await state.failoverEngine.runHealthCheckNow();
      res.json({ ok: true, statuses: state.failoverEngine.getStatuses() });
    } catch (err) {
      logger.error({ err }, 'failover_health_check_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Failed to run health check.' } });
    }
  });

  // GET /admin/api/cron/provider-health — external cron endpoint (secured by CRON_SECRET)
  router.get('/cron/provider-health', async (req: Request, res: Response) => {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${cronSecret}`) {
        res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } });
        return;
      }
    }
    try {
      await state.failoverEngine.runHealthCheckNow();
      res.json({ ok: true, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error({ err }, 'cron_health_check_failed');
      res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Health check failed.' } });
    }
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
    const finalModel = body?.model?.trim() || 'claude-sonnet-4-6';

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

      const existingPermissions = (existing.permissions ?? {}) as Record<string, unknown>;
      const updatedPermissions = {
        ...existingPermissions,
        defaultMode: "auto",
        skipDangerousModePermissionPrompt: true,
      };

      const updated: Record<string, unknown> = {
        ...existing,
        env: updatedEnv,
        permissions: updatedPermissions,
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

  // ── Gateway API Keys & Setup Endpoints ─────────────────────────────────────

  // GET /admin/api/gateway-keys — list all gateway API keys and endpoint metadata
  router.get('/gateway-keys', (_req: Request, res: Response) => {
    const port = getConfig().port;
    const host = _req.hostname || 'localhost';
    const proxyBaseUrl = `http://${host}:${port}`;
    const masterKey = state.configManager.getProxyApiKey() || getConfig().proxyApiKey;

    res.json({
      keys: state.gatewayKeyManager.getAll(),
      activeCount: state.gatewayKeyManager.getActiveCount(),
      totalCount: state.gatewayKeyManager.getTotalCount(),
      masterKeySet: Boolean(masterKey),
      proxyPort: port,
      proxyBaseUrl,
      openaiBaseUrl: `${proxyBaseUrl}/v1`,
      anthropicBaseUrl: proxyBaseUrl,
      authSchemes: ['bearer', 'x-api-key'],
    });
  });

  // POST /admin/api/gateway-keys — generate a new gateway API key
  router.post('/gateway-keys', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: string; expiresDays?: number };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Default Key';
    const expiresDays = typeof body.expiresDays === 'number' && body.expiresDays > 0 ? body.expiresDays : undefined;

    const result = state.gatewayKeyManager.createKey(name, expiresDays);
    res.status(201).json({
      ok: true,
      key: result.key,
      snapshot: result.snapshot,
    });
  });

  // DELETE /admin/api/gateway-keys/:id — delete a key permanently
  router.delete('/gateway-keys/:id', (req: Request, res: Response) => {
    const deleted = state.gatewayKeyManager.deleteKey(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: { message: 'Key not found', type: 'not_found' } });
      return;
    }
    res.json({ ok: true });
  });

  // POST /admin/api/gateway-keys/:id/revoke — revoke an active key
  router.post('/gateway-keys/:id/revoke', (req: Request, res: Response) => {
    const revoked = state.gatewayKeyManager.revokeKey(req.params.id);
    if (!revoked) {
      res.status(404).json({ error: { message: 'Key not found', type: 'not_found' } });
      return;
    }
    res.json({ ok: true });
  });

  // GET /admin/api/gateway-setup — precomputed setup configurations for Claude Desktop, Claude Code, and Codex
  router.get('/gateway-setup', (req: Request, res: Response) => {
    const port = getConfig().port;
    const host = req.hostname || 'localhost';
    const proxyBaseUrl = `http://${host}:${port}`;
    const allKeys = state.gatewayKeyManager.getAll();
    const firstActive = allKeys.find((k) => !k.revoked);
    const sampleKey = firstActive ? `${firstActive.keyPreview}` : 'sk-gw-...';

    res.json({
      claudeDesktop: {
        connectionType: 'Gateway',
        credentialKind: 'Static API key',
        gatewayBaseUrl: proxyBaseUrl,
        gatewayApiKeyPlaceholder: sampleKey,
        authScheme: 'bearer',
        supportedAuthSchemes: ['bearer', 'x-api-key'],
        notes: 'In Claude Desktop > Settings > Connection > choose Gateway and enter these credentials.',
      },
      claudeCode: {
        baseUrl: proxyBaseUrl,
        shellCommands: `export ANTHROPIC_BASE_URL="${proxyBaseUrl}"\nexport ANTHROPIC_API_KEY="${sampleKey}"\nclaude`,
        fishCommands: `set -x ANTHROPIC_BASE_URL "${proxyBaseUrl}"\nset -x ANTHROPIC_API_KEY "${sampleKey}"\nclaude`,
        powershellCommands: `$env:ANTHROPIC_BASE_URL="${proxyBaseUrl}"\n$env:ANTHROPIC_API_KEY="${sampleKey}"\nclaude`,
      },
      openaiCompatible: {
        baseUrl: `${proxyBaseUrl}/v1`,
        sampleKey,
        pythonSnippet: `import openai\n\nclient = openai.OpenAI(\n    base_url="${proxyBaseUrl}/v1",\n    api_key="${sampleKey}",\n)\n\nresponse = client.chat.completions.create(\n    model="claude-3-7-sonnet",\n    messages=[{"role": "user", "content": "Hello!"}],\n)\nprint(response.choices[0].message.content)`,
        nodeSnippet: `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: '${proxyBaseUrl}/v1',\n  apiKey: '${sampleKey}',\n});\n\nconst completion = await client.chat.completions.create({\n  model: 'claude-3-7-sonnet',\n  messages: [{ role: 'user', content: 'Hello!' }],\n});\nconsole.log(completion.choices[0].message.content);`,
        curlSnippet: `curl ${proxyBaseUrl}/v1/chat/completions \\\n  -H "Authorization: Bearer ${sampleKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"claude-3-7-sonnet","messages":[{"role":"user","content":"Hello!"}]}'`,
        vscodeSettingsSnippet: JSON.stringify({
          "github.copilot.advanced": {
            "debug.overrideEngine": "claude-3-7-sonnet",
            "debug.overrideProxyUrl": `${proxyBaseUrl}/v1`
          }
        }, null, 2),
      },
    });
  });

  return router;
}
