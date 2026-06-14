/**
 * Context Management Admin API Routes
 *
 * GET  /admin/api/context          — Returns current context usage stats
 * POST /admin/api/context/compact  — Triggers manual compaction
 * GET  /admin/api/context/sessions — List all tracked sessions
 * GET  /admin/api/context/history  — Compaction history
 * GET  /admin/api/context/summary/:sessionId — Get session summary
 * GET  /admin/api/context/project-state/:sessionId — Get project state
 * GET  /admin/api/context/settings — Get auto-compact settings
 * PUT  /admin/api/context/settings — Update auto-compact settings
 * DELETE /admin/api/context/sessions/:sessionId — Clear a session
 * DELETE /admin/api/context/sessions — Clear all sessions
 */

import { Router, type Request, type Response } from 'express';
import { getLogger } from '../../utils/logger';
import type { ContextTracker } from '../../auto-compact/context-tracker';
import type { AutoCompactSettings } from '../../auto-compact/types';

const logger = getLogger();

export function buildContextRouter(tracker: ContextTracker): Router {
  const router = Router();

  // ── GET /admin/api/context ────────────────────────────────────────────────
  router.get('/', (_req: Request, res: Response) => {
    try {
      const status = tracker.getContextStatus();
      res.json(status);
    } catch (err) {
      logger.error({ err }, 'context_status_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to get context status.' },
      });
    }
  });

  // ── POST /admin/api/context/compact ───────────────────────────────────────
  router.post('/compact', async (req: Request, res: Response) => {
    try {
      const body = req.body as { sessionId?: string; level?: 1 | 2 | 3 };
      const highestSession = tracker.getHighestUsageSession();

      if (!highestSession && !body.sessionId) {
        res.status(400).json({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'No active sessions to compact.',
          },
        });
        return;
      }

      const sessionId = body.sessionId ?? highestSession!.sessionId;
      const window = tracker.getHighestUsageSession();

      if (!window) {
        res.json({
          ok: true,
          message: 'No sessions require compaction at this time.',
          compacted: false,
        });
        return;
      }

      // Admin compact clears the session tracking so next request starts fresh
      tracker.clearSession(sessionId);

      res.json({
        ok: true,
        compacted: true,
        sessionId,
        message: 'Session context cleared. Next request will start with a fresh context window.',
        previousStats: {
          usedTokens: window.usedTokens,
          maxTokens: window.maxTokens,
          usagePercent: Math.round(window.usageRatio * 100),
          compactionCount: window.compactionCount,
        },
      });
    } catch (err) {
      logger.error({ err }, 'context_compact_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Compaction failed.' },
      });
    }
  });

  // ── GET /admin/api/context/sessions ──────────────────────────────────────
  router.get('/sessions', (_req: Request, res: Response) => {
    try {
      const status = tracker.getContextStatus();
      res.json({
        sessions: status.topSessions,
        activeSessions: status.activeSessions,
        sessionsNearLimit: status.sessionsNearLimit,
      });
    } catch (err) {
      logger.error({ err }, 'context_sessions_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to get sessions.' },
      });
    }
  });

  // ── GET /admin/api/context/history ───────────────────────────────────────
  router.get('/history', (_req: Request, res: Response) => {
    try {
      const history = tracker.store.getHistory();
      res.json(history);
    } catch (err) {
      logger.error({ err }, 'context_history_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to get history.' },
      });
    }
  });

  // ── GET /admin/api/context/summary/:sessionId ─────────────────────────────
  router.get('/summary/:sessionId', (req: Request, res: Response) => {
    try {
      const summary = tracker.store.getSummary(req.params.sessionId);
      if (!summary) {
        res.status(404).json({
          type: 'error',
          error: { type: 'not_found_error', message: 'Session summary not found.' },
        });
        return;
      }
      res.json(summary);
    } catch (err) {
      logger.error({ err }, 'context_summary_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to get session summary.' },
      });
    }
  });

  // ── GET /admin/api/context/project-state/:sessionId ──────────────────────
  router.get('/project-state/:sessionId', (req: Request, res: Response) => {
    try {
      const state = tracker.store.getProjectState(req.params.sessionId);
      if (!state) {
        res.status(404).json({
          type: 'error',
          error: { type: 'not_found_error', message: 'Project state not found.' },
        });
        return;
      }
      res.json(state);
    } catch (err) {
      logger.error({ err }, 'context_project_state_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to get project state.' },
      });
    }
  });

  // ── GET /admin/api/context/settings ──────────────────────────────────────
  router.get('/settings', (_req: Request, res: Response) => {
    try {
      res.json(tracker.store.getSettings());
    } catch (err) {
      logger.error({ err }, 'context_settings_get_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to get settings.' },
      });
    }
  });

  // ── PUT /admin/api/context/settings ──────────────────────────────────────
  router.put('/settings', (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<AutoCompactSettings>;
      const patch: Partial<AutoCompactSettings> = {};

      if ('enabled' in body) {
        if (typeof body.enabled !== 'boolean') {
          res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'enabled must be a boolean.' },
          });
          return;
        }
        patch.enabled = body.enabled;
      }

      if ('compactThreshold' in body) {
        const v = Number(body.compactThreshold);
        if (!Number.isFinite(v) || v < 0.5 || v > 0.99) {
          res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'compactThreshold must be between 0.5 and 0.99.' },
          });
          return;
        }
        patch.compactThreshold = v;
      }

      if ('warnThreshold' in body) {
        const v = Number(body.warnThreshold);
        if (!Number.isFinite(v) || v < 0.4 || v > 0.98) {
          res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'warnThreshold must be between 0.4 and 0.98.' },
          });
          return;
        }
        patch.warnThreshold = v;
      }

      if ('keepRecentMessages' in body) {
        const v = Math.floor(Number(body.keepRecentMessages));
        if (!Number.isFinite(v) || v < 5 || v > 100) {
          res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'keepRecentMessages must be between 5 and 100.' },
          });
          return;
        }
        patch.keepRecentMessages = v;
      }

      if ('generateSummary' in body) {
        if (typeof body.generateSummary !== 'boolean') {
          res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'generateSummary must be a boolean.' },
          });
          return;
        }
        patch.generateSummary = body.generateSummary;
      }

      if ('defaultContextSize' in body) {
        const v = Math.floor(Number(body.defaultContextSize));
        if (!Number.isFinite(v) || v < 1000 || v > 10_000_000) {
          res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'defaultContextSize must be between 1000 and 10000000.' },
          });
          return;
        }
        patch.defaultContextSize = v;
      }

      const updated = tracker.store.updateSettings(patch);
      res.json(updated);
    } catch (err) {
      logger.error({ err }, 'context_settings_put_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to update settings.' },
      });
    }
  });

  // ── DELETE /admin/api/context/sessions/:sessionId ─────────────────────────
  router.delete('/sessions/:sessionId', (req: Request, res: Response) => {
    try {
      tracker.clearSession(req.params.sessionId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'context_session_delete_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to delete session.' },
      });
    }
  });

  // ── DELETE /admin/api/context/sessions ───────────────────────────────────
  router.delete('/sessions', (_req: Request, res: Response) => {
    try {
      tracker.clearAll();
      res.json({ ok: true, message: 'All sessions cleared.' });
    } catch (err) {
      logger.error({ err }, 'context_sessions_clear_error');
      res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Failed to clear sessions.' },
      });
    }
  });

  return router;
}
