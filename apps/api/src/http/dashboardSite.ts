import { stat } from 'node:fs/promises';
import path from 'node:path';

import express, { type Express, type RequestHandler } from 'express';

import type { Logger } from '../ports/logger.js';

// Same-origin serving of the Angular build (CLAUDE.md: one origin, so the SameSite=Lax session cookie is sent).
// No CORS anywhere: this file is also why none is needed.

const INDEX_FILE = 'index.html';
const ONE_YEAR_SECONDS = 31_536_000;
const HSTS_SECONDS = 15_552_000; // 180 days; no includeSubDomains, the host may share a parent domain

/** Routes owned by the server. The SPA fallback must never answer for them. */
const SERVER_PATHS = /^\/(?:api|interactions|healthz)(?:\/|$)/i;
/** A request for `something.ext` is a file, not an Angular route: a missing file is a real 404. */
const HAS_FILE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
/** The Angular builder names bundles `main-7WQXNTDT.js`: content-hashed, so safe to cache forever. */
const CONTENT_HASHED_ASSET = /-[A-Z0-9]{8}\.(?:js|css|woff2?)$/;

/**
 * The Content-Security-Policy for the dashboard (Angular security guide, "static hosting"):
 * - script-src 'self' with NO 'unsafe-inline': the build must not need inline scripts. That means
 *   `optimization.styles.inlineCritical: false` (or autoCsp) in the Angular build, see the report.
 * - style-src 'unsafe-inline': Angular Material and component styles are injected as <style> at runtime.
 * - connect-src 'self': the SPA talks only to this origin's /api.
 * - frame-ancestors 'none' (no embedding, clickjacking), object-src 'none', base-uri and form-action 'self'.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * A small explicit header set instead of helmet: one fewer dependency that runs with our secrets in the
 * environment, and every header is visible and tested here. Applied to every response, API included.
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', `max-age=${String(HSTS_SECONDS)}`);
  next();
};

function cacheControlFor(filePath: string): string {
  return CONTENT_HASHED_ASSET.test(filePath)
    ? `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable`
    : 'no-cache'; // revalidate (ETag) so a new deploy shows up at once
}

/**
 * The directory to serve, or undefined when it has no `index.html` (no build yet), which is logged and is not an
 * error: the API runs without a dashboard. Checked once at startup, so a build made later needs a restart.
 */
export async function findDashboardDir(
  distDir: string,
  logger: Logger,
): Promise<string | undefined> {
  const root = path.resolve(distDir);
  // The path is operator config (WEB_DIST_DIR), never request input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const hasIndex = await stat(path.join(root, INDEX_FILE)).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!hasIndex) {
    logger.warn({ webDistDir: root }, 'web.dist_missing');
    return undefined;
  }
  logger.info({ webDistDir: root }, 'web.serving_dashboard');
  return root;
}

/**
 * Serves the Angular build from `root` (a directory `findDashboardDir` accepted), with `index.html` for any other
 * GET/HEAD that is not a server route or a file. Mount it after every API route so it can never shadow one.
 */
export function mountDashboard(app: Express, root: string): void {
  const indexPath = path.join(root, INDEX_FILE);

  const staticFiles = express.static(root, {
    index: false, // index.html goes through the fallback below, so it gets one cache policy
    dotfiles: 'ignore',
    fallthrough: true,
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', cacheControlFor(filePath));
    },
  });
  // The static layer decodes the path itself, so `/api/%2e%2e/index.html` would resolve to a file inside the build.
  // Decide on the raw path instead: anything under a server route never reaches the files.
  app.use((req, res, next) => {
    if (SERVER_PATHS.test(req.path)) {
      next();
      return;
    }
    staticFiles(req, res, next);
  });

  const fallback: RequestHandler = (req, res, next) => {
    const isPageRequest = req.method === 'GET' || req.method === 'HEAD';
    if (!isPageRequest || SERVER_PATHS.test(req.path) || HAS_FILE_EXTENSION.test(req.path)) {
      next();
      return;
    }
    res.sendFile(
      indexPath,
      { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache' } },
      (error?: Error) => {
        if (error !== undefined) {
          next(error);
        }
      },
    );
  };
  app.use(fallback);
}
