import rateLimit from 'express-rate-limit';
import { getConfig } from '../config/env';

export function buildRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: () => getConfig().rateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const cfg = getConfig();
      res.setHeader('Retry-After', '60');
      const isOpenAI = req.originalUrl?.startsWith('/v1/chat') || req.originalUrl?.startsWith('/v1/models');
      if (isOpenAI) {
        res.status(429).json({
          error: {
            message: `Rate limit exceeded. Limit: ${cfg.rateLimitPerMinute}/min.`,
            type: 'rate_limit_error',
            param: null,
            code: 429,
          },
        });
      } else {
        res.status(429).json({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `Rate limit exceeded. Limit: ${cfg.rateLimitPerMinute}/min.`,
          },
        });
      }
    },
  });
}
