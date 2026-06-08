import cors from 'cors';
import type { CorsOptions } from 'cors';
import { getConfig } from '../config/env';

export function buildCors() {
  const options: CorsOptions = {
    origin: (origin, cb) => {
      const cfg = getConfig();
      const allowed = cfg.allowedOrigins;
      if (!origin) return cb(null, true);
      if (allowed.length === 0) {
        if (cfg.nodeEnv === 'production') {
          return cb(new Error('CORS: origin not allowed'));
        }
        return cb(null, true);
      }
      if (allowed.includes('*') || allowed.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('CORS: origin not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'api-key', 'x-request-id'],
    maxAge: 86400,
  };
  return cors(options);
}
