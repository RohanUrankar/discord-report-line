#!/usr/bin/env node
// A stand-in for Slack / Discord webhooks / Discord REST / the LLM API, so failure modes can be tested on demand.
// Point the API's base URLs at it via env (e.g. MIRROR_WEBHOOK_URL=http://127.0.0.1:4010/mirror).
//
//   node stub-downstream.mjs --port 4010 --mode ok|slow|error|ratelimit|gone|flaky [--delay 8000] [--fail-count 2]
//
// Modes:
//   ok         200 {}
//   slow       waits --delay ms (default 8000), then 200 — exercises timeouts and the 3 s window
//   error      503 — transient, should be retried
//   ratelimit  429 with retry_after 1.5 (body + Retry-After header) — should be honoured
//   gone       404 {"code":10015,"message":"Unknown Webhook"} — permanent, should go dead without retrying
//   flaky      first --fail-count requests per path return 503, then 200 — should succeed after retries
// "Down" = don't run this at all, or stop it: connection refused is its own failure mode worth testing.
//
// Switch mode while running:  curl -X POST "http://127.0.0.1:4010/__mode?m=gone"
// Request counts per path:   curl http://127.0.0.1:4010/__stats
// Bodies are not logged — they may contain user text.

import { createServer } from 'node:http';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]);
  return acc;
}, []));

const port = Number(args.port ?? 4010);
let mode = args.mode ?? 'ok';
const delay = Number(args.delay ?? 8000);
const failCount = Number(args['fail-count'] ?? 2);
const hits = new Map();

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  for await (const _ of req) { /* drain body */ }

  if (pathname === '/__mode' && req.method === 'POST') {
    mode = searchParams.get('m') ?? mode;
    hits.clear();
    console.log(`mode → ${mode}`);
    return json(res, 200, { mode });
  }
  if (pathname === '/__stats') return json(res, 200, { mode, hits: Object.fromEntries(hits) });

  const n = (hits.get(pathname) ?? 0) + 1;
  hits.set(pathname, n);
  console.log(`${new Date().toISOString()} ${req.method} ${pathname} #${n} mode=${mode}`);

  switch (mode) {
    case 'ok': return json(res, 200, {});
    case 'slow': await new Promise(r => setTimeout(r, delay)); return json(res, 200, {});
    case 'error': return json(res, 503, { message: 'stub: service unavailable' });
    case 'ratelimit':
      res.setHeader('Retry-After', '2');
      return json(res, 429, { message: 'You are being rate limited.', retry_after: 1.5, global: false });
    case 'gone': return json(res, 404, { code: 10015, message: 'Unknown Webhook' });
    case 'flaky': return n <= failCount ? json(res, 503, { message: `stub: failing ${n}/${failCount}` }) : json(res, 200, {});
    default: return json(res, 500, { message: `stub: unknown mode ${mode}` });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`stub-downstream listening on http://127.0.0.1:${port} mode=${mode}`));

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
