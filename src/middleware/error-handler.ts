import type { NextFunction, Request, Response } from 'express';
import { getLogger } from '../utils/logger';
import { anthropicError } from '../converters/errors';
import { getConfig } from '../config/env';

export class HttpError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: `Route not found: ${req.method} ${req.originalUrl || req.url}`,
    },
  });
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const cfg = getConfig();
  const logger = getLogger();

  if (res.headersSent) {
    logger.error({ err, request_id: req.requestId }, 'error_after_headers_sent');
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      type: 'error',
      error: { type: err.type as never, message: err.message },
    });
    return;
  }

  const isPayloadTooLarge =
    (err as { type?: string; statusCode?: number }).type === 'entity.too.large' ||
    (err as { statusCode?: number }).statusCode === 413;

  if (isPayloadTooLarge) {
    const e = anthropicError('request_too_large', 'Request body too large.', 413);
    res.status(413).json(e.body);
    return;
  }

  const isBodyParse = (err as { type?: string; statusCode?: number }).type === 'entity.parse.failed';
  if (isBodyParse) {
    const e = anthropicError('invalid_request_error', `Invalid JSON body: ${err.message}`, 400);
    res.status(400).json(e.body);
    return;
  }

  logger.error(
    { err, request_id: req.requestId, debug: cfg.debugLogs ? { stack: err.stack } : undefined },
    'internal_proxy_error',
  );

  const e = anthropicError('proxy_error', 'Internal proxy error.', 500);
  res.status(500).json(e.body);
}
