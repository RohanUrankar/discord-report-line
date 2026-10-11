#!/usr/bin/env node
// Throws the assignment's "junk" at a Discord interactions endpoint and reports pass/fail.
//
//   node attack.mjs --gen-key
//       Prints a test Ed25519 keypair. Start the API with DISCORD_PUBLIC_KEY=<public> to enable signed checks.
//   node attack.mjs --url http://localhost:3000/interactions --private-key <hex> [--command status] [--json]
//       Runs all checks. Without --private-key only unsigned checks run (the only kind possible against
//       production, where the endpoint trusts Discord's real key).
//
// Node 18+ only, no dependencies. Exit code 1 if any check fails.

import { generateKeyPairSync, createPrivateKey, sign, randomBytes } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const DISCORD_EPOCH = 1420070400000n;
const RESPONSE_BUDGET_MS = 3000;
const RESPONSE_TARGET_MS = 1500;

const args = parseArgs(process.argv.slice(2));

if (args['gen-key']) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  console.log(`DISCORD_PUBLIC_KEY=${publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex')}`);
  console.log(`ATTACK_PRIVATE_KEY=${privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex')}`);
  console.log('\nUse these only for local/staging. Never commit them or configure production with them.');
  process.exit(0);
}

const url = args.url;
if (!url) {
  console.error('Usage: node attack.mjs --url <interactions endpoint> [--private-key <hex>] [--command <name>] [--json]');
  process.exit(2);
}
const keyHex = args['private-key'] ?? process.env.ATTACK_PRIVATE_KEY;
const key = keyHex ? keyFromSeed(keyHex) : null;
const commandName = args.command ?? 'status';

const checks = [
  // Unsigned — safe to run against production.
  { name: 'missing signature headers → 401', run: async () => {
      const r = await send(body(command()), {});
      return expectStatus(r, [401]);
  } },
  { name: 'garbage signature → 401', run: async () => {
      const r = await send(body(command()), { sig: 'zz-not-hex', ts: now() });
      return expectStatus(r, [401]);
  } },
  { name: 'well-formed signature from the wrong key → 401', run: async () => {
      const wrong = generateKeyPairSync('ed25519').privateKey;
      const b = body(command()); const ts = now();
      const r = await send(b, { sig: signWith(wrong, ts, b), ts });
      return expectStatus(r, [401]);
  } },
  { name: 'GET on the endpoint is not a 2xx', run: async () => {
      const r = await send(null, {}, 'GET');
      return r.status >= 200 && r.status < 300 ? fail(r, 'GET returned 2xx') : pass(r);
  } },
  // Signed — need the test private key matching the server's DISCORD_PUBLIC_KEY.
  { name: 'PING → 200 {"type":1}', signed: true, run: async () => {
      const r = await sendSigned(body({ id: snowflake(), type: 1, application_id: '900000000000000001', token: 'test', version: 1 }));
      if (r.status !== 200) return fail(r, `status ${r.status}`);
      return safeJson(r.text)?.type === 1 ? pass(r) : fail(r, `body ${truncate(r.text)}`);
  } },
  { name: 'valid signature but tampered body → 401', signed: true, run: async () => {
      const b = body(command()); const ts = now();
      const sig = signWith(key, ts, b);
      const r = await send(b.replace(commandName, `${commandName}x`), { sig, ts });
      return expectStatus(r, [401]);
  } },
  { name: 'stale timestamp (10 min old, correctly signed) → 401 (replay window)', signed: true, run: async () => {
      const r = await sendSigned(body(command()), now() - 600);
      if (r.status === 401) return pass(r);
      return r.status < 300 ? warn(r, 'accepted — timestamp freshness not enforced (dedup still limits replays)') : fail(r, `status ${r.status}`);
  } },
  { name: 'signed malformed JSON → 4xx, not 5xx', signed: true, run: async () => {
      const r = await sendSigned('{"type": 2, "id": ');
      return r.status >= 400 && r.status < 500 ? pass(r) : fail(r, `status ${r.status}`);
  } },
  { name: 'signed unknown interaction type → handled, not 5xx', signed: true, run: async () => {
      const r = await sendSigned(body({ ...command(), type: 99 }));
      return r.status >= 500 ? fail(r, `status ${r.status}`) : pass(r, `status ${r.status}`);
  } },
  { name: `/${commandName} answered within ${RESPONSE_BUDGET_MS} ms`, signed: true, run: async () => {
      const r = await sendSigned(body(command()));
      if (r.status !== 200) return fail(r, `status ${r.status} ${truncate(r.text)}`);
      const type = safeJson(r.text)?.type;
      if (![4, 5, 9].includes(type)) return fail(r, `unexpected callback type ${type}`);
      if (r.ms > RESPONSE_BUDGET_MS) return fail(r, `${r.ms} ms`);
      return r.ms > RESPONSE_TARGET_MS ? warn(r, `${r.ms} ms — over the ${RESPONSE_TARGET_MS} ms safety target`) : pass(r, `type ${type}, ${r.ms} ms`);
  } },
  { name: 'same interaction delivered twice → no 5xx (verify ONE row/one side effect)', signed: true, run: async () => {
      const b = body(command());
      const first = await sendSigned(b);
      const second = await sendSigned(b);
      if (first.status >= 500 || second.status >= 500) return fail(second, `statuses ${first.status}/${second.status}`);
      return manual(second, `statuses ${first.status}/${second.status}; check DB/dashboard for a single record of id ${JSON.parse(b).id}`);
  } },
  { name: '5 concurrent duplicates → no 5xx (verify ONE row)', signed: true, run: async () => {
      const b = body(command());
      const results = await Promise.all(Array.from({ length: 5 }, () => sendSigned(b)));
      const bad = results.filter(r => r.status >= 500);
      if (bad.length) return fail(bad[0], `${bad.length}/5 returned 5xx — likely a unique-constraint error not handled`);
      return manual(results[0], `statuses ${results.map(r => r.status).join(',')}; check for a single record of id ${JSON.parse(b).id}`);
  } },
  { name: 'user text with @everyone does not enable mentions', signed: true, run: async () => {
      const r = await sendSigned(body(command('@everyone hello')));
      const data = safeJson(r.text)?.data;
      if (r.status >= 500) return fail(r, `status ${r.status}`);
      if (!data?.content) return manual(r, 'response was deferred/had no content — check the follow-up message sets allowed_mentions.parse = []');
      const parse = data.allowed_mentions?.parse;
      return Array.isArray(parse) && parse.length === 0 ? pass(r) : fail(r, `allowed_mentions = ${JSON.stringify(data.allowed_mentions)}`);
  } },

  // Last on purpose: an early 413 can leave the keep-alive socket unusable for the next request.
  { name: 'oversized unsigned body (2 MB) → 401/413, no 5xx or hang', run: async () => {
      const r = await send('x'.repeat(2 * 1024 * 1024), { sig: '00'.repeat(64), ts: now() });
      return expectStatus(r, [400, 401, 413]);
  } },
];

const results = [];
for (const check of checks) {
  if (check.signed && !key) { results.push({ name: check.name, outcome: 'skip', detail: 'no --private-key' }); continue; }
  try {
    results.push({ name: check.name, ...(await check.run()) });
  } catch (err) {
    results.push({ name: check.name, outcome: 'fail', detail: `request error: ${err.name}: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}` });
  }
}

if (args.json) {
  console.log(JSON.stringify({ url, results }, null, 2));
} else {
  const icon = { pass: '✅', fail: '❌', warn: '⚠️ ', manual: '👀', skip: '⏭️ ' };
  console.log(`Quality-bar attack against ${url}\n`);
  for (const r of results) console.log(`${icon[r.outcome]} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  const count = o => results.filter(r => r.outcome === o).length;
  console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('warn')} warnings, ${count('manual')} need a manual check, ${count('skip')} skipped`);
}
// exitCode rather than process.exit(): exiting with fetch sockets still open crashes Node on Windows.
process.exitCode = results.some(r => r.outcome === 'fail') ? 1 : 0;

// ---------------------------------------------------------------------------

function command(text = 'quality bar probe') {
  return {
    id: snowflake(),
    application_id: '900000000000000001',
    type: 2,
    token: `attack-${randomBytes(8).toString('hex')}`,
    version: 1,
    guild_id: args.guild ?? '900000000000000002',
    channel_id: '900000000000000003',
    member: { user: { id: '900000000000000004', username: 'quality-verifier' }, permissions: '0' },
    data: { id: '900000000000000005', name: commandName, type: 1, options: [{ name: 'text', type: 3, value: text }] },
  };
}

function body(obj) { return JSON.stringify(obj); }
function now() { return Math.floor(Date.now() / 1000); }
function snowflake() {
  return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | BigInt(randomBytes(2).readUInt16BE() & 0x3fffff));
}

function keyFromSeed(hex) {
  const seed = Buffer.from(hex, 'hex');
  if (seed.length !== 32) throw new Error('private key must be a 32-byte hex seed (from --gen-key)');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function signWith(privateKey, ts, rawBody) {
  return sign(null, Buffer.from(`${ts}${rawBody}`), privateKey).toString('hex');
}

function sendSigned(rawBody, ts = now()) {
  return send(rawBody, { sig: signWith(key, ts, rawBody), ts });
}

async function send(rawBody, { sig, ts }, method = 'POST') {
  const headers = { 'content-type': 'application/json', 'user-agent': 'quality-bar-attack/1.0' };
  if (sig !== undefined) headers['x-signature-ed25519'] = sig;
  if (ts !== undefined) headers['x-signature-timestamp'] = String(ts);
  const started = performance.now();
  const res = await fetch(url, { method, headers, body: rawBody ?? undefined, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  return { status: res.status, text, ms: Math.round(performance.now() - started) };
}

function expectStatus(r, allowed) {
  return allowed.includes(r.status) ? pass(r) : fail(r, `status ${r.status} (expected ${allowed.join('/')}) ${truncate(r.text)}`);
}
function pass(r, detail) { return { outcome: 'pass', detail: detail ?? `${r.status}, ${r.ms} ms` }; }
function fail(r, detail) { return { outcome: 'fail', detail }; }
function warn(r, detail) { return { outcome: 'warn', detail }; }
function manual(r, detail) { return { outcome: 'manual', detail }; }
function safeJson(text) { try { return JSON.parse(text); } catch { return undefined; } }
function truncate(s, n = 120) { return s.length > n ? `${s.slice(0, n)}…` : s; }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
  }
  return out;
}
