import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config/env';

export interface AuthOptions {
  enabled: boolean;
}

function extractKey(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    return auth.trim();
  }
  const x = req.header('x-api-key');
  if (x) return x.trim();
  const ak = req.header('api-key');
  if (ak) return ak.trim();
  return null;
}

/** Constant-time string comparison — prevents timing side-channel on the key. */
function safeKeyEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded);
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const cfg = getConfig();
  if (!cfg.proxyApiKey) {
    next();
    return;
  }

  const provided = extractKey(req);
  if (!provided || !safeKeyEqual(provided, cfg.proxyApiKey)) {
    res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Missing or invalid proxy API key. Set Authorization: Bearer <PROXY_API_KEY> or x-api-key: <PROXY_API_KEY>.',
      },
    });
    return;
  }
  next();
}
