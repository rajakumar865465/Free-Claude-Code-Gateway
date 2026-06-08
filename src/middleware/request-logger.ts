import type { NextFunction, Request, Response } from 'express';
import { getLogger } from '../utils/logger';
import { newRequestId } from '../utils/request-id';
import { redactHeaderValue, safeStringify } from '../utils/redact';
import { getConfig } from '../config/env';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    startTime?: number;
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const id = (req.header('x-request-id') || req.header('x-correlation-id') || newRequestId()).trim();
  req.requestId = id;
  req.startTime = Date.now();
  res.setHeader('x-request-id', id);
  next();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = req.startTime ?? Date.now();
  const method = req.method;
  const path = req.originalUrl || req.url;
  const ip = req.ip ?? req.socket.remoteAddress ?? '';

  // Guard against double-fire: 'finish' and 'close' can both be queued before
  // the first handler runs, causing the log entry to be written twice.
  let logged = false;

  const finished = () => {
    if (logged) return;
    logged = true;
    res.removeListener('finish', finished);
    res.removeListener('close', finished);
    const cfg = getConfig();
    const logger = getLogger();
    const duration = Date.now() - start;
    const status = res.statusCode;
    const model =
      (req.body && typeof req.body === 'object' && (req.body as Record<string, unknown>).model) ||
      undefined;
    const providerModel =
      (res.locals && (res.locals as Record<string, unknown>).providerModel) || undefined;
    const fields: Record<string, unknown> = {
      request_id: req.requestId,
      method,
      path,
      status,
      duration_ms: duration,
      ip,
      model,
      provider_model: providerModel,
    };
    if (cfg.debugLogs) {
      fields.headers = {
        authorization: redactHeaderValue('authorization', req.header('authorization')),
        'x-api-key': redactHeaderValue('x-api-key', req.header('x-api-key')),
      };
      fields.body = safeStringify(req.body, 1000);
    }
    if (status >= 500) {
      logger.error(fields, 'request_failed');
    } else if (status >= 400) {
      logger.warn(fields, 'request_warn');
    } else {
      logger.info(fields, 'request_completed');
    }
  };

  res.on('finish', finished);
  res.on('close', finished);
  next();
}
