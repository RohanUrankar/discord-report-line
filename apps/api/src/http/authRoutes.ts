import { CSRF_HEADER, ErrorCode, LoginRequest, type SessionInfo } from '@report-line/shared';
import { Router, type Request, type RequestHandler } from 'express';

import type { AuthService, AuthenticatedAdmin } from '../app/auth.js';
import type { Logger } from '../ports/logger.js';
import { contextOf, sendApiError } from './middleware.js';
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  type SessionCookieSettings,
} from './sessionCookie.js';

export interface AuthHttpDeps {
  auth: AuthService;
  cookie: SessionCookieSettings;
  logger: Logger;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UNKNOWN_IP = 'unknown';
const MS_PER_SECOND = 1000;

const signedInAdmins = new WeakMap<Request, AuthenticatedAdmin>();

/** The admin `requireSession` resolved for this request. Throws if the middleware was not mounted first. */
export function adminOf(req: Request): AuthenticatedAdmin {
  const admin = signedInAdmins.get(req);
  if (admin === undefined) {
    throw new Error('adminOf() used on a route without requireSession.');
  }
  return admin;
}

/**
 * Who did what, and did it work (observability skill). Ids and short reason codes only: no email, no password,
 * no cookie. `src` is the client address, kept for the audit trail.
 */
function securityEvent(
  req: Request,
  logger: Logger,
  level: 'info' | 'warn',
  event: string,
  fields: { result: 'success' | 'failed'; reason?: string; adminId?: string },
): void {
  contextOf(req, logger).log[level]({ logType: 'security', event, src: req.ip, ...fields }, event);
}

/** Every `/api` route behind login uses this: 401 without a live session, otherwise `adminOf(req)` works. */
export function requireSession({ auth, cookie, logger }: AuthHttpDeps): RequestHandler {
  return async (req, res, next) => {
    const check = await auth.authenticate(readSessionCookie(req, cookie));
    if (check.kind === 'ok') {
      signedInAdmins.set(req, check.admin);
      next();
      return;
    }
    if (check.kind === 'expired') {
      securityEvent(req, logger, 'info', 'auth.session.expired', {
        result: 'failed',
        adminId: check.adminId,
      });
      clearSessionCookie(res, cookie);
    }
    sendApiError(req, res, 401, ErrorCode.UNAUTHENTICATED);
  };
}

/**
 * Every request that changes something must carry the session's CSRF token in `X-CSRF-Token` (SR-6, T-06).
 * Mount it after `requireSession`; GET, HEAD and OPTIONS pass untouched.
 */
export function requireCsrf({ auth, logger }: AuthHttpDeps): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const admin = adminOf(req);
    if (auth.hasValidCsrf(admin, req.header(CSRF_HEADER))) {
      next();
      return;
    }
    securityEvent(req, logger, 'warn', 'auth.csrf.rejected', {
      result: 'failed',
      adminId: admin.adminId,
    });
    sendApiError(req, res, 403, ErrorCode.CSRF_REJECTED);
  };
}

function sessionInfo(admin: AuthenticatedAdmin): SessionInfo {
  return { admin: { id: admin.adminId, email: admin.email }, csrfToken: admin.csrfToken };
}

/** `/api/auth`: login, logout and who-am-i. Mounted after the JSON body parser. */
export function authRouter(deps: AuthHttpDeps): Router {
  const { auth, cookie, logger } = deps;
  const router = Router();
  const session = requireSession(deps);
  const csrf = requireCsrf(deps);

  router.post('/login', async (req, res) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) {
      sendApiError(req, res, 400, ErrorCode.VALIDATION_FAILED);
      return;
    }
    const result = await auth.login({
      ...body.data,
      ip: req.ip ?? UNKNOWN_IP,
      previousSessionId: readSessionCookie(req, cookie),
    });
    switch (result.kind) {
      case 'signed_in':
        setSessionCookie(res, cookie, result.sessionId);
        securityEvent(req, logger, 'info', 'auth.login.succeeded', {
          result: 'success',
          adminId: result.admin.adminId,
        });
        res.status(200).json(sessionInfo(result.admin));
        return;
      case 'invalid_credentials':
        securityEvent(req, logger, 'warn', 'auth.login.failed', {
          result: 'failed',
          reason: 'invalid_credentials',
        });
        sendApiError(req, res, 401, ErrorCode.INVALID_CREDENTIALS);
        return;
      case 'rate_limited':
        securityEvent(req, logger, 'warn', 'auth.login.rate_limited', {
          result: 'failed',
          reason: 'rate_limited',
        });
        res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / MS_PER_SECOND));
        sendApiError(req, res, 429, ErrorCode.RATE_LIMITED);
        return;
    }
  });

  router.post('/logout', session, csrf, async (req, res) => {
    await auth.logout(readSessionCookie(req, cookie));
    clearSessionCookie(res, cookie);
    securityEvent(req, logger, 'info', 'auth.logout', {
      result: 'success',
      adminId: adminOf(req).adminId,
    });
    res.status(204).end();
  });

  router.get('/me', session, (req, res) => {
    res.status(200).json(sessionInfo(adminOf(req)));
  });

  return router;
}
