import type { NextFunction, Request, Response } from 'express';
import type { AdminState } from './admin-state';
import { newRequestId } from '../utils/request-id';

function extractTokens(body: unknown): { input: number; output: number } {
  if (!body || typeof body !== 'object') return { input: 0, output: 0 };
  const b = body as Record<string, unknown>;
  if (typeof b.usage === 'object' && b.usage) {
    const u = b.usage as Record<string, unknown>;
    const input = Number(
      (u.prompt_tokens as number) ?? (u.input_tokens as number) ?? 0,
    ) || 0;
    const output = Number(
      (u.completion_tokens as number) ?? (u.output_tokens as number) ?? 0,
    ) || 0;
    return { input, output };
  }
  return { input: 0, output: 0 };
}

function recordFromLocals(state: AdminState, req: Request, res: Response, start: number): void {
  const captured = (res as unknown as { __capturedBody?: unknown }).__capturedBody;
  let inputTokens = 0;
  let outputTokens = 0;
  if (captured !== undefined) {
    const t = extractTokens(captured);
    inputTokens = t.input;
    outputTokens = t.output;
  }
  const endpoint = req.originalUrl || req.url;
  const clientModel =
    (req.body && typeof req.body === 'object'
      ? ((req.body as Record<string, unknown>).model as string | undefined)
      : undefined) ?? '';
  const resolved = (res.locals as Record<string, unknown>).providerModel;
  const resolvedModel = typeof resolved === 'string' ? resolved : '';
  state.requestLog.record({
    endpoint,
    method: req.method,
    clientModel,
    resolvedModel,
    status: res.statusCode,
    inputTokens,
    outputTokens,
    latencyMs: Date.now() - start,
    streaming: Boolean(
      (req.body && typeof req.body === 'object' && (req.body as Record<string, unknown>).stream) ||
        (req.headers.accept || '').toString().includes('text/event-stream'),
    ),
    error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined,
  });
}

export function buildRequestLogMiddleware(state: AdminState) {
  return function requestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!req.requestId) {
      req.requestId = newRequestId();
      res.setHeader('x-request-id', req.requestId);
    }
    const start = req.startTime ?? Date.now();

    // Capture res.json body so we can pull token counts later
    const originalJson = res.json.bind(res);
    (res as unknown as { json: typeof res.json }).json = ((body: unknown) => {
      (res as unknown as { __capturedBody?: unknown }).__capturedBody = body;
      return originalJson(body);
    }) as typeof res.json;

    // Guard against double-fire: 'finish' and 'close' can both fire for the
    // same response (e.g. client disconnect mid-response). Record only once.
    let recorded = false;
    const onFinish = () => {
      if (recorded) return;
      recorded = true;
      // Streaming responses (SSE) record their own log entry inside handleStreaming
      // to capture accurate token counts. Skip logging here for those.
      if ((res.locals as Record<string, unknown>).__skipLogCapture) return;
      recordFromLocals(state, req, res, start);
    };

    res.on('finish', onFinish);
    res.on('close', onFinish);
    next();
  };
}
