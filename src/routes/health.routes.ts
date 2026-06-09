import { Router, type Request, type Response } from 'express';
import { getConfig } from '../config/env';

export function buildHealthRouter(): Router {
  const router = Router();

  // Silence browser favicon requests — returns empty 204 to avoid 404 noise in logs
  router.get('/favicon.ico', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  // Read config at request time so hot-reloaded values are always current
  router.get('/health', (_req: Request, res: Response) => {
    const cfg = getConfig();
    res.json({
      ok: true,
      name: cfg.name,
      version: cfg.version,
    });
  });

  router.get('/', (_req: Request, res: Response) => {
    const cfg = getConfig();
    res.json({
      name: cfg.name,
      status: 'running',
      version: cfg.version,
      endpoints: ['/health', '/v1/models', '/v1/messages', '/v1/chat/completions'],
    });
  });

  return router;
}
