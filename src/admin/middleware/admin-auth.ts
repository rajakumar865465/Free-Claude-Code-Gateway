import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../../config/env';

/**
 * Constant-time string comparison that does not leak length information.
 * Pads both strings to the same length before comparing so the loop duration
 * is not influenced by where they first differ.
 */
function safeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, 'utf8');
  const bBytes = Buffer.from(b, 'utf8');
  // Pad to the same length so timingSafeEqual doesn't throw and the
  // comparison time is not length-dependent.
  const len = Math.max(aBytes.length, bBytes.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBytes.copy(aPadded);
  bBytes.copy(bPadded);
  return timingSafeEqual(aPadded, bPadded);
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export interface AdminAuthOptions {
  enabled: boolean;
}

export function buildAdminAuth(opts: AdminAuthOptions) {
  return function adminAuth(req: Request, res: Response, next: NextFunction): void {
    if (!opts.enabled) {
      next();
      return;
    }
    const cfg = getConfig();
    const expected = cfg.adminPassword;
    // Never grant access if the expected password is empty — this would mean
    // auth is "enabled" but configured with a blank password, which is a
    // misconfiguration. Fail closed rather than open.
    if (!expected) {
      res
        .status(503)
        .json({
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Admin auth is enabled but ADMIN_PASSWORD is not set. Set ADMIN_PASSWORD to continue.',
          },
        });
      return;
    }
    const creds = parseBasicAuth(req.header('authorization'));
    if (creds && safeEqual(creds.pass, expected)) {
      next();
      return;
    }
    res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="FCC Gateway Admin", charset="UTF-8"')
      .json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Admin authentication required.',
        },
      });
  };
}
