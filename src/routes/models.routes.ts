import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service';
import { getLogger } from '../utils/logger';
import type { AdminState } from '../admin/admin-state';

interface StandardModelDef {
  id: string;
  display_name: string;
  created_at: string;
  created: number;
}

const STANDARD_CLAUDE_MODELS: StandardModelDef[] = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-mythos-5-1', display_name: 'Claude Mythos 5.1', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-mythos-5', display_name: 'Claude Mythos 5', created_at: '2026-09-01T00:00:00Z', created: 1788220800 },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2025-05-14T00:00:00Z', created: 1747180800 },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2025-05-14T00:00:00Z', created: 1747180800 },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2025-05-14T00:00:00Z', created: 1747180800 },
  { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2025-05-14T00:00:00Z', created: 1747180800 },
];

function getDisplayName(id: string): string {
  const match = STANDARD_CLAUDE_MODELS.find((m) => m.id === id);
  if (match) return match.display_name;
  const name = id.includes('/') ? id.split('/')[1] : id;
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function getCreatedDate(id: string): { created_at: string; created: number } {
  const match = STANDARD_CLAUDE_MODELS.find((m) => m.id === id);
  if (match) return { created_at: match.created_at, created: match.created };
  const now = Date.now();
  return {
    created_at: new Date(now).toISOString(),
    created: Math.floor(now / 1000),
  };
}

export function buildModelsRouter(service: BluesmindsService, _state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  const buildModelList = async (): Promise<Array<{
    id: string;
    type: 'model';
    object: 'model';
    display_name: string;
    created_at: string;
    created: number;
    owned_by: string;
  }>> => {
    const seen = new Set<string>();
    const models: Array<{
      id: string;
      type: 'model';
      object: 'model';
      display_name: string;
      created_at: string;
      created: number;
      owned_by: string;
    }> = [];

    const addModel = (id: string, ownedBy = 'anthropic', displayName?: string, createdAt?: string, createdUnix?: number) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const dateInfo = getCreatedDate(id);
      models.push({
        id,
        type: 'model',
        object: 'model',
        display_name: displayName ?? getDisplayName(id),
        created_at: createdAt ?? dateInfo.created_at,
        created: createdUnix ?? dateInfo.created,
        owned_by: ownedBy,
      });
    };

    // 1. Standard Claude models first (so Claude Desktop / Code model discovery matches immediately)
    for (const m of STANDARD_CLAUDE_MODELS) {
      addModel(m.id, 'anthropic', m.display_name, m.created_at, m.created);
    }

    // 2. Active provider and local registry mappings
    const activeProvider = _state.providerManager?.getActive?.();
    const defaultModel = _state.configManager?.getDefaultModel?.();
    if (defaultModel) addModel(defaultModel, activeProvider?.name ?? 'custom');
    if (activeProvider?.defaultModel) addModel(activeProvider.defaultModel, activeProvider.name ?? 'custom');

    const snap = _state.modelRegistry?.snapshot?.();
    if (snap) {
      if (snap.default) addModel(snap.default, 'custom');
      Object.keys(snap.mappings || {}).forEach((k) => addModel(k, 'anthropic'));
      Object.values(snap.mappings || {}).forEach((v) => addModel(v, 'custom'));
    }

    // 3. Upstream provider models (e.g. Bluesminds/OpenAI models)
    try {
      // Fast timeout: don't let a slow provider break the UI dropdowns
      const result = await Promise.race([
        service.listModels(),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('upstream fetch timeout')), 2000))
      ]);
      if (result?.ok && result?.body) {
        const bodyData = (result.body as { data?: Array<{ id: string; owned_by?: string; created?: number }> })?.data;
        if (Array.isArray(bodyData)) {
          for (const m of bodyData) {
            if (m?.id) {
              addModel(m.id, m.owned_by ?? 'upstream', undefined, undefined, m.created);
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'models_list_upstream_fetch_warning');
    }

    return models;
  };

  const modelsHandler = async (_req: Request, res: Response): Promise<void> => {
    const data = await buildModelList();
    // Return dual-compatible payload:
    // - Anthropic expects { data: [ { type: "model", id, display_name, created_at } ], has_more: false, first_id, last_id }
    // - OpenAI expects { object: "list", data: [ { id, object: "model", created, owned_by } ] }
    res.status(200).json({
      object: 'list',
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    });
  };

  const singleModelHandler = async (req: Request, res: Response): Promise<void> => {
    const modelId = req.params.model_id;
    const dateInfo = getCreatedDate(modelId);
    res.status(200).json({
      id: modelId,
      type: 'model',
      object: 'model',
      display_name: getDisplayName(modelId),
      created_at: dateInfo.created_at,
      created: dateInfo.created,
      owned_by: modelId.startsWith('claude') ? 'anthropic' : 'custom',
    });
  };

  router.get('/v1/models', modelsHandler);
  router.get('/models', modelsHandler);
  router.get('/v1/v1/models', modelsHandler);

  router.get('/v1/models/:model_id', singleModelHandler);
  router.get('/models/:model_id', singleModelHandler);
  router.get('/v1/v1/models/:model_id', singleModelHandler);

  return router;
}
