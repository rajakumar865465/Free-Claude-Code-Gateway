import { Router, type Request, type Response } from 'express';
import { BluesmindsService } from '../services/bluesminds.service';
import { getLogger } from '../utils/logger';
import type { AdminState } from '../admin/admin-state';

export function buildModelsRouter(service: BluesmindsService, _state: AdminState): Router {
  const router = Router();
  const logger = getLogger();

  router.get('/v1/models', async (_req: Request, res: Response) => {
    const result = await service.listModels();
    if (!result.ok) {
      logger.warn({ status: result.status }, 'models_list_failed');
      const errBody = (result.body as { error?: { message?: string } } | null)?.error;
      const message = errBody?.message ?? 'Failed to list models from upstream provider.';
      // /v1/models is an OpenAI-format endpoint — return OpenAI-style error
      res.status(result.status).json({ error: { message, type: 'api_error', param: null, code: null } });
      return;
    }
    res.status(200).json(result.body);
  });

  return router;
}
