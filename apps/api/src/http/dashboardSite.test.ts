import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InboundInteraction, InteractionHandler } from '../app/interactions.js';
import { inertAuth } from '../../test/helpers/authFakes.js';
import { LogSink } from '../../test/helpers/logging.js';
import { CONTENT_SECURITY_POLICY, findDashboardDir } from './dashboardSite.js';
import { createLogger } from './middleware.js';
import { createServer } from './server.js';

const INDEX_HTML = '<!doctype html><html><body><app-root></app-root>SPA-SHELL</body></html>';
const HASHED_JS = 'main-7WQXNTDT.js';
const PLAIN_ICON = 'favicon.ico';
const SIGNED_BODY = '{"type":1}';

class RecordingHandler implements InteractionHandler {
  public readonly seen: InboundInteraction[] = [];

  public handle(request: InboundInteraction): ReturnType<InteractionHandler['handle']> {
    this.seen.push(request);
    return Promise.resolve({ status: 401 });
  }
}

let distDir: string;
let sink: LogSink;

beforeAll(async () => {
  distDir = await mkdtemp(path.join(tmpdir(), 'report-line-web-'));
  await writeFile(path.join(distDir, 'index.html'), INDEX_HTML);
  await writeFile(path.join(distDir, HASHED_JS), 'console.log("app");');
  await writeFile(path.join(distDir, PLAIN_ICON), 'icon');
  await writeFile(path.join(distDir, 'styles.css'), 'body{margin:0}');
  await mkdir(path.join(distDir, 'assets'));
  await writeFile(path.join(distDir, '.hidden'), 'dotfile');
});

afterAll(async () => {
  await rm(distDir, { recursive: true, force: true });
});

async function serverWith(candidateDir: string | undefined) {
  sink = new LogSink();
  const handler = new RecordingHandler();
  const logger = createLogger('debug', sink);
  const webDistDir =
    candidateDir === undefined ? undefined : await findDashboardDir(candidateDir, logger);
  const app = createServer({
    controller: handler,
    logger,
    ...inertAuth(),
    ...(webDistDir === undefined ? {} : { webDistDir }),
  });
  return { app, handler };
}

describe('dashboard served from the API origin', () => {
  it('WHEN a browser opens a deep SPA route THE SYSTEM SHALL return index.html with no-cache', async () => {
    const { app } = await serverWith(distDir);

    const res = await request(app).get('/servers/123/settings').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('WHEN the root is requested THE SYSTEM SHALL return index.html', async () => {
    const { app } = await serverWith(distDir);

    const res = await request(app).get('/');

    expect(res.text).toBe(INDEX_HTML);
  });

  it('WHEN a content-hashed bundle is requested THE SYSTEM SHALL serve it as JavaScript with a one-year immutable cache', async () => {
    const { app } = await serverWith(distDir);

    const res = await request(app).get(`/${HASHED_JS}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('WHEN an unhashed asset is requested THE SYSTEM SHALL serve it revalidating, with its own type', async () => {
    const { app } = await serverWith(distDir);

    const css = await request(app).get('/styles.css');
    const icon = await request(app).get(`/${PLAIN_ICON}`);

    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect(css.headers['cache-control']).toBe('no-cache');
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('WHEN a file that does not exist is requested THE SYSTEM SHALL answer 404, not index.html', async () => {
    const { app } = await serverWith(distDir);

    const res = await request(app).get('/main-MISSING1.js');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('SPA-SHELL');
  });

  it('WHEN a dotfile or a path traversal is requested THE SYSTEM SHALL not serve it', async () => {
    const { app } = await serverWith(distDir);

    const dotfile = await request(app).get('/.hidden');
    const traversal = await request(app).get('/..%2f..%2fpackage.json');

    expect(dotfile.text).not.toContain('dotfile');
    expect(traversal.text).not.toContain('"name"');
    expect(traversal.status).not.toBe(200);
  });

  it.each(['get', 'post', 'put', 'delete', 'patch'] as const)(
    'WHEN an unknown /api route is called with %s THE SYSTEM SHALL answer a JSON 404 in the error shape, never index.html',
    async (method) => {
      const { app } = await serverWith(distDir);

      const res = await request(app)[method]('/api/does-not-exist').set('Accept', 'text/html');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const { error } = JSON.parse(res.text) as { error: { code: string; requestId: string } };
      expect(error.code).toBe('NOT_FOUND');
      expect(error.requestId).not.toBe('');
      expect(res.text).not.toContain('SPA-SHELL');
    },
  );

  it('WHEN /api itself is requested THE SYSTEM SHALL answer the JSON 404', async () => {
    const { app } = await serverWith(distDir);

    const res = await request(app).get('/api');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it.each([
    '/api/%2e%2e/index.html',
    '/api/%2E%2E/styles.css',
    '/API/%2e%2e/index.html',
    '/api/..%2findex.html',
  ])(
    'WHEN %s (dot segments under /api) is requested THE SYSTEM SHALL answer the JSON 404, not a file from the build',
    async (route) => {
      const { app } = await serverWith(distDir);

      const res = await request(app).get(route).set('Accept', 'text/html');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.text).not.toContain('SPA-SHELL');
      expect(res.text).not.toContain('margin:0');
    },
  );

  it('WHEN a non-GET request hits a SPA route THE SYSTEM SHALL not answer with index.html', async () => {
    const { app } = await serverWith(distDir);

    const res = await request(app).post('/servers/123');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('SPA-SHELL');
  });

  it('WHEN GET /interactions or GET /healthz are called THE SYSTEM SHALL not let the fallback swallow them', async () => {
    const { app } = await serverWith(distDir);

    const interactions = await request(app).get('/interactions');
    const health = await request(app).get('/healthz');

    expect(interactions.status).toBe(404);
    expect(interactions.text).not.toContain('SPA-SHELL');
    expect(health.body).toEqual({ status: 'ok' });
  });

  it('WHEN a signed interaction arrives with the dashboard mounted THE SYSTEM SHALL still hand the verifier the exact raw bytes', async () => {
    const { app, handler } = await serverWith(distDir);

    const res = await request(app)
      .post('/interactions')
      .set('Content-Type', 'application/json')
      .set('X-Signature-Ed25519', 'ab')
      .set('X-Signature-Timestamp', '1')
      .send(SIGNED_BODY);

    expect(res.status).toBe(401);
    const [seen] = handler.seen;
    expect(Buffer.isBuffer(seen?.rawBody)).toBe(true);
    expect(seen?.rawBody?.toString('utf8')).toBe(SIGNED_BODY);
  });

  it('WHEN the dist directory is missing THE SYSTEM SHALL start, log it, and keep the API working', async () => {
    const { app } = await serverWith(path.join(distDir, 'does-not-exist'));

    const page = await request(app).get('/servers');
    const health = await request(app).get('/healthz');

    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toMatch(/application\/json/);
    expect(health.status).toBe(200);
    expect(sink.messages()).toContain('web.dist_missing');
  });

  it('WHEN a directory exists without index.html THE SYSTEM SHALL treat it as missing', async () => {
    const { app } = await serverWith(path.join(distDir, 'assets'));

    const page = await request(app).get('/');

    expect(page.status).toBe(404);
    expect(sink.messages()).toContain('web.dist_missing');
  });

  it('WHEN no dist directory is configured THE SYSTEM SHALL serve only the API', async () => {
    const { app } = await serverWith(undefined);

    const res = await request(app).get('/');

    expect(res.status).toBe(404);
    expect(sink.messages()).not.toContain('web.serving_dashboard');
  });

  it('WHEN the dashboard is mounted THE SYSTEM SHALL log where it serves from', async () => {
    await serverWith(distDir);

    expect(sink.messages()).toContain('web.serving_dashboard');
  });
});

describe('response headers', () => {
  it.each([
    ['the SPA shell', '/dashboard'],
    ['a static asset', `/${HASHED_JS}`],
    ['an API error', '/api/nope'],
    ['an unknown path', '/main-MISSING1.js'],
    ['the health check', '/healthz'],
  ])('WHEN %s is served THE SYSTEM SHALL send the security headers', async (_label, route) => {
    const { app } = await serverWith(distDir);

    const res = await request(app).get(route);

    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toMatch(/^max-age=\d+$/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('THE SYSTEM SHALL keep script-src free of unsafe-inline and forbid framing', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src 'self'(;|$)/);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe/);
  });

  it('WHEN any response is sent, even to a cross-origin preflight, THE SYSTEM SHALL add no Access-Control-* header', async () => {
    const { app } = await serverWith(distDir);
    const requests = [
      request(app).get('/').set('Origin', 'https://evil.example'),
      request(app).get(`/${HASHED_JS}`).set('Origin', 'https://evil.example'),
      request(app).get('/api/nope').set('Origin', 'https://evil.example'),
      request(app).get('/healthz').set('Origin', 'https://evil.example'),
      request(app)
        .options('/api/auth/login')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST'),
      request(app).post('/interactions').set('Origin', 'https://evil.example'),
    ];

    for (const pending of requests) {
      const res = await pending;
      const corsHeaders = Object.keys(res.headers).filter((name) =>
        name.startsWith('access-control-'),
      );
      expect(corsHeaders).toEqual([]);
    }
  });
});
