import express, { Router, type Express, type RequestHandler } from 'express';

import type { AuthService } from '../app/auth.js';
import type { DashboardService } from '../app/dashboard.js';
import type { GuildConfigService } from '../app/guildConfig.js';
import { healthHttpStatus, type HealthService } from '../app/health.js';
import type { InteractionHandler } from '../app/interactions.js';
import type { Logger } from '../ports/logger.js';
import { authRouter } from './authRoutes.js';
import { dashboardRouter, type DashboardHttpDeps } from './dashboardRoutes.js';
import { mountDashboard, securityHeaders } from './dashboardSite.js';
import type { SessionCookieSettings } from './sessionCookie.js';
import {
  contextOf,
  errorHandler,
  notFoundHandler,
  rawInteractionBody,
  requestContext,
} from './middleware.js';

/** Authenticated responses must never be stored by a browser or a shared cache (security-secrets). */
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * Behind a TLS-terminating proxy every request arrives from the proxy's address unless TRUST_PROXY_HOPS tells
 * Express how many hops to believe. Left at 0, the login throttle would count every admin as one client. A
 * forwarded-for header with no trust configured is the symptom, so say so once (a log line, not a refusal:
 * a header can also be forged by a direct client).
 */
function warnOnUnconfiguredProxy(trustProxyHops: number, logger: Logger): RequestHandler {
  let warned = false;
  return (req, _res, next) => {
    if (trustProxyHops === 0 && !warned && req.header('x-forwarded-for') !== undefined) {
      warned = true;
      contextOf(req, logger).log.warn({}, 'config.proxy_not_trusted');
    }
    next();
  };
}

function apiRouter(deps: DashboardHttpDeps): Router {
  const router = Router();
  router.use('/auth', authRouter(deps));
  router.use(dashboardRouter(deps));
  return router;
}

export interface ServerDeps {
  controller: InteractionHandler;
  logger: Logger;
  auth: AuthService;
  dashboard: DashboardService;
  guildConfig: GuildConfigService;
  cookie: SessionCookieSettings;
  /** Reverse proxies in front of the app (0 = none), so `req.ip`, which the login throttle keys on, is real. */
  trustProxyHops?: number;
  /** The `/healthz` verdict. Absent (unit tests): liveness only, no dependency is touched. */
  health?: HealthService;
  /** A directory `findDashboardDir` accepted: the Angular build to serve from this same origin. Undefined: API only. */
  webDistDir?: string;
}

/** Dashboard request bodies are small forms; anything bigger is refused with 413. */
const MAX_API_BODY_BYTES = 16 * 1024;

/**
 * Builds the Express app without listening, so tests can drive it with Supertest (backend-guidelines).
 * This is the composition point for the request path (DESIGN §8.2).
 *
 * Body-parser rule (CLAUDE.md): the raw parser is mounted on `/interactions` only. The JSON parser is mounted
 * on `/api` only, never globally, so it can never touch the signed bytes. The SPA build is served from this same origin
 * (after every API route, so it can never shadow one), hence no CORS.
 */
export function createServer({
  controller,
  logger,
  auth,
  dashboard,
  guildConfig,
  cookie,
  trustProxyHops = 0,
  health,
  webDistDir,
}: ServerDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  app.use(requestContext(logger));
  app.use(warnOnUnconfiguredProxy(trustProxyHops, logger));
  app.use(securityHeaders);

  app.get('/healthz', async (req, res) => {
    if (health === undefined) {
      res.json({ status: 'ok' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const report = await health.check();
    if (report.status !== 'ok') {
      contextOf(req, logger).log.warn({ db: report.db, worker: report.worker }, 'health.unhealthy');
    }
    res.status(healthHttpStatus(report)).json(report);
  });

  app.post('/interactions', rawInteractionBody(), async (req, res) => {
    const { log } = contextOf(req, logger);
    const result = await controller.handle(
      {
        timestamp: req.header('x-signature-timestamp'),
        signature: req.header('x-signature-ed25519'),
        // Without a matching content type the raw parser leaves no Buffer; the verifier then rejects it.
        rawBody: Buffer.isBuffer(req.body) ? req.body : undefined,
      },
      log,
    );
    if (result.status === 200) {
      res.status(200).json(result.body);
      return;
    }
    res.status(result.status).end();
  });

  app.use(
    '/api',
    noStore,
    express.json({ limit: MAX_API_BODY_BYTES }),
    apiRouter({ auth, cookie, logger, dashboard, guildConfig }),
  );

  if (webDistDir !== undefined) {
    mountDashboard(app, webDistDir);
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
