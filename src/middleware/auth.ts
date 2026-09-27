import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config/env';
import type { AdminState } from '../admin/admin-state';

export interface AuthOptions {
  enabled: boolean;
}

function getHeader(req: Request, name: string): string | undefined {
  if (typeof req.header === 'function') return req.header(name);
  if (typeof req.get === 'function') return req.get(name);
  const val = (req.headers as Record<string, string | string[] | undefined> | undefined)?.[name.toLowerCase()] ??
              (req.headers as Record<string, string | string[] | undefined> | undefined)?.[name];
  return Array.isArray(val) ? val[0] : val;
}

export function extractKey(req: Request): string | null {
  const auth = getHeader(req, 'authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    return auth.trim();
  }
  const x = getHeader(req, 'x-api-key');
  if (x) return x.trim();
  const ak = getHeader(req, 'api-key');
  if (ak) return ak.trim();
  return null;
}

/** Constant-time string comparison — prevents timing side-channel on the key. */
export function safeKeyEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const len = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  a.copy(aPadded);
  b.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded);
}

export function buildAuthMiddleware(state?: AdminState) {
  return function authHandler(req: Request, res: Response, next: NextFunction): void {
    const cfg = getConfig();
    const masterKey = state?.configManager?.getProxyApiKey() || cfg.proxyApiKey;
    const hasGatewayKeys = state ? state.gatewayKeyManager.getActiveCount() > 0 : false;
    const authRequired = Boolean(masterKey) || hasGatewayKeys;

    if (!authRequired) {
      next();
      return;
    }

    const provided = extractKey(req);
    if (provided) {
      // 1. Check generated Gateway API Keys
      if (state) {
        const val = state.gatewayKeyManager.validateKey(provided);
        if (val.valid) {
          res.locals = { ...(res.locals ?? {}), gatewayKey: { id: val.keyId, name: val.name } };
          next();
          return;
        }
      }

      // 2. Check master/static proxy API key
      if (masterKey && safeKeyEqual(provided, masterKey)) {
        res.locals = { ...(res.locals ?? {}), gatewayKey: { id: 'master', name: 'Master Proxy Key' } };
        next();
        return;
      }
    }

    // Unauthorized — return 401 with appropriate schema
    const url = req.originalUrl || req.url || '';
    const isOpenAI = url.includes('/chat') || url.includes('/models');
    if (isOpenAI) {
      res.status(401).json({
        error: {
          message: 'Missing or invalid Gateway API key. Provide via Authorization: Bearer <KEY> or x-api-key: <KEY>.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
    } else {
      res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Missing or invalid Gateway API key. Provide via Authorization: Bearer <KEY> or x-api-key: <KEY>.',
        },
      });
    }
  };
}

export const authMiddleware = buildAuthMiddleware();

