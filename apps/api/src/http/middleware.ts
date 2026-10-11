import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';

import { ErrorCode, errorMessages, type ApiErrorBody } from '@report-line/shared';
import express, {
  type ErrorRequestHandler,
  type Handler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { pino } from 'pino';

import type { Logger } from '../ports/logger.js';

/** Discord interactions are a few KB; anything bigger is not Discord (security-secrets: body size limit). */
export const MAX_INTERACTION_BODY_BYTES = 100 * 1024;

const CENSOR = '[redacted]';
const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;
const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * Fields that must never reach a log line (ADR-0005, CLAUDE.md). The interaction token is a 15-minute
 * capability; the rest are credentials. pino wildcards match one level, so top-level and nested forms are
 * both listed; the two-level forms cover a whole job row or ledger input logged by mistake
 * (`job.interaction_token`, `input.job.interactionToken`). Pinned by middleware.test.ts.
 */
export const REDACT_PATHS = [
  'token',
  'interaction_token',
  'interactionToken',
  '*.token',
  '*.interaction_token',
  '*.interactionToken',
  '*.*.token',
  '*.*.interaction_token',
  '*.*.interactionToken',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'password',
  '*.password',
  'botToken',
  '*.botToken',
  'webhookUrl',
  '*.webhookUrl',
  'databaseUrl',
  '*.databaseUrl',
  'apiKey',
  '*.apiKey',
] as const;

export function createLogger(level: string, destination?: Writable): Logger {
  return pino({ level, redact: { paths: [...REDACT_PATHS], censor: CENSOR } }, destination);
}

interface RequestContext {
  requestId: string;
  log: Logger;
}

const contexts = new WeakMap<Request, RequestContext>();

/** The per-request logger and id set by `requestContext`. Falls back to a fresh id if used before it. */
export function contextOf(req: Request, fallbackLog: Logger): RequestContext {
  return contexts.get(req) ?? { requestId: randomUUID(), log: fallbackLog };
}

/**
 * Assigns a request id (never trusts a header that is not a short token, so it cannot inject into logs),
 * returns it as `x-request-id`, and logs one line when the response finishes.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const supplied = req.header('x-request-id');
    const requestId =
      supplied !== undefined && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    const log = logger.child({ request_id: requestId });
    contexts.set(req, { requestId, log });
    res.setHeader('x-request-id', requestId);
    const startedAt = performance.now();
    res.on('finish', () => {
      // req.path, not the URL: a query string is not ours to log.
      log.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'http.request',
      );
    });
    next();
  };
}

/**
 * The raw-body parser for `/interactions` ONLY (CLAUDE.md). Discord signs the exact bytes, so the body must
 * reach the verifier untouched: no JSON parser may run before it, and none is mounted globally.
 */
export function rawInteractionBody(): Handler {
  return express.raw({ type: 'application/json', limit: MAX_INTERACTION_BODY_BYTES });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendApiError(req, res, 404, ErrorCode.NOT_FOUND);
};

/** The one way an `/api` handler or middleware answers with an error: shared shape, message and request id. */
export function sendApiError(req: Request, res: Response, status: number, code: ErrorCode): void {
  const { requestId } = contextOf(req, noopLogger);
  res.status(status).json(errorBody(code, requestId));
}

/**
 * The single error handler. Logs once with the request id, never returns internals.
 * On `/interactions` a request the body parser rejects is not an authentic Discord request, so it gets a bare
 * 401 (413 for an oversized body), never a 500 (CLAUDE.md).
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const { requestId, log } = contextOf(req, logger);
    const clientStatus = clientErrorStatus(error);
    if (req.path === '/interactions' && clientStatus !== undefined) {
      log.warn({ logType: 'security', status: clientStatus }, 'interaction.body_rejected');
      res.status(clientStatus === 413 ? 413 : 401).end();
      return;
    }
    if (req.path.startsWith('/api') && clientStatus !== undefined) {
      // A body the JSON parser refused (malformed, wrong type, too large): the client's mistake, not ours.
      log.warn({ status: clientStatus }, 'http.api_body_rejected');
      sendApiError(req, res, clientStatus === 413 ? 413 : 400, ErrorCode.VALIDATION_FAILED);
      return;
    }
    log.error(describeError(error), 'http.unhandled_error');
    res.status(500).json(errorBody(ErrorCode.INTERNAL, requestId));
  };
}

function errorBody(code: ErrorCode, requestId: string): ApiErrorBody {
  return { error: { code, message: errorMessages[code], requestId } };
}

/** body-parser errors carry the HTTP status the parser chose (413, 415, 400...). */
function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const { status } = error;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/** Name, code and a truncated message: enough to debug, no stack and no object graph. */
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError' };
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return {
    errorName: error.name,
    errorCode: code,
    errorMessage: error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
  };
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};
