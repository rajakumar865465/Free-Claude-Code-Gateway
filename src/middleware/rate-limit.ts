import rateLimit from 'express-rate-limit';
import { getConfig } from '../config/env';

export function buildRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: () => getConfig().rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      const cfg = getConfig();
      res.status(429).json({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: `Rate limit exceeded. Limit: ${cfg.rateLimitPerMinute}/min.`,
        },
      });
    },
  });
}
