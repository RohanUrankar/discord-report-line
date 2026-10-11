# Secure coding patterns (Node + Express + TypeScript)

Snippets show the *shape* of the safe version. Check library signatures against the installed versions (Context7) before pasting. Each ✗ is a pattern AI-written code produces regularly.

## Contents
1. SSRF guard for webhook URLs
2. Constant-time comparison
3. AES-256-GCM for stored webhook URLs
4. Pollution-safe maps and parsing untrusted JSON
5. Safe path join
6. Express hardening block
7. Process-level handlers
8. Redaction test
9. Pre-commit anti-pattern scan

---

## 1. SSRF guard for webhook URLs

```ts
const ALLOWED_WEBHOOK_HOSTS = new Set(['hooks.slack.com', 'discord.com', 'discordapp.com']);

export function parseMirrorWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError({ code: 'MIRROR_WEBHOOK_INVALID', status: 400 });
  }
  const isAllowed =
    url.protocol === 'https:' &&
    ALLOWED_WEBHOOK_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (url.pathname.startsWith('/services/') || url.pathname.startsWith('/api/webhooks/'));
  if (!isAllowed) {
    throw new AppError({ code: 'MIRROR_WEBHOOK_INVALID', status: 400 });
  }
  return url;
}

// at send time (re-validate after decrypting; never trust the stored value blindly)
const res = await fetch(parseMirrorWebhookUrl(decrypted), {
  method: 'POST',
  redirect: 'manual',                       // a 3xx is a failure, not a hop
  signal: AbortSignal.timeout(config.SLACK_TIMEOUT_MS),
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
```

Hostname matching uses the parsed `URL`, not `startsWith`/regex on the raw string (`https://hooks.slack.com.evil.test/` and `https://hooks.slack.com@evil.test/` both defeat string checks). The allow-list is config in the deployed environment so tests can point at the local stub via an explicit test-only override that is impossible to enable in production (fail startup if the override is set while `NODE_ENV=production`).

## 2. Constant-time comparison

```ts
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
```

`timingSafeEqual` throws if lengths differ, so check length first. Use for CSRF tokens, session-id hashes and any shared secret. Plain `===` leaks prefix length through timing.

## 3. AES-256-GCM for stored webhook URLs

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);                 // fresh per message — never reuse with GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}
```

The key is 32 random bytes supplied as base64/hex in env and length-checked at startup (`config.ts`). A tampered ciphertext makes `final()` throw — treat that as "webhook unreadable", fail the job as dead with a readable reason, and never log the ciphertext or plaintext. Tests: round-trip; two encryptions of the same plaintext differ; a flipped byte fails.

## 4. Pollution-safe maps and parsing untrusted JSON

```ts
// keyed by a user-controlled string → Map, not {}
const handlers = new Map<string, Handler>([['report', handleReport], ['triage', handleTriage]]);
const handler = handlers.get(customId);          // 'constructor' / '__proto__' simply miss

// parsing: JSON.parse → unknown → schema. Unknown keys dropped/rejected.
const parsed = bodySchema.strict().safeParse(JSON.parse(text));
```

✗ `const merged = { ...defaults, ...req.body }` / `Object.assign(config, input)` — let a request set keys it should never control. Parse through a schema and copy known fields explicitly.

## 5. Safe path join

Only needed if a filesystem path ever includes input (you should avoid that):

```ts
import path from 'node:path';

export function resolveInside(root: string, untrusted: string): string {
  const resolved = path.resolve(root, untrusted);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AppError({ code: 'BAD_PATH', status: 400 });
  }
  return resolved;
}
```

✗ `resolved.startsWith(root)` alone — `/srv/app-secrets` starts with `/srv/app`. Reject NUL bytes too. Prefer an ID → fixed-path lookup over any user-chosen path.

## 6. Express hardening block

```ts
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY_HOPS);          // so rate limiting sees the real client IP

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],         // Angular Material; tighten if the built app allows
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
}));

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');              // never cache authenticated JSON
  next();
});
```

Mount `express.raw` for `/interactions` first (see CLAUDE.md), then `express.json({ limit: '100kb' })` for the rest. `/interactions` gets its own body limit too. Load the built SPA in a browser with the console open: every CSP violation message names the directive to adjust — widen only for what is actually blocked.

## 7. Process-level handlers

```ts
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: toSafeError(reason) }, 'process.unhandled_rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err: toSafeError(err) }, 'process.uncaught_exception');
  process.exit(1);
});
```

The host restarts the process; unfinished jobs are recovered by the lease. `toSafeError` keeps `name`/`message`/`stack` after redaction, and strips URLs with credentials. Flush the logger before exit if it is async.

## 8. Redaction test

```ts
it('redacts the interaction token and auth headers', () => {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  log.info({ token: 'abc.def', req: { headers: { authorization: 'Bot xyz', cookie: 'sid=1' } } }, 'x');
  expect(lines.join('')).not.toMatch(/abc\.def|Bot xyz|sid=1/);
});
```

## 9. Pre-commit anti-pattern scan

Run over the files you changed (`rg` is available; adapt paths). Every hit is either fixed or justified in a comment on that line.

```bash
rg -n --glob '*.{ts,js,mjs}' \
  -e '\beval\s*\(' -e 'new\s+Function\s*\(' \
  -e 'rejectUnauthorized\s*:\s*false' -e 'NODE_TLS_REJECT_UNAUTHORIZED' \
  -e "createHash\(\s*['\"](md5|sha1)['\"]" \
  -e 'Math\.random\(\)' \
  -e 'console\.(log|debug|info)\(' \
  -e '(query|execute)\(\s*`[^`]*\$\{' \
  -e '\bexec(Sync)?\(\s*`[^`]*\$\{' \
  -e 'bypassSecurityTrust' -e '\[innerHTML\]' -e 'localStorage\.(set|get)Item\([^)]*(token|secret|password)' \
  -e 'Object\.assign\(\s*[a-zA-Z_.]*\s*,\s*req\.' -e '\.\.\.req\.(body|query|params)' \
  apps packages scripts
```

Also grep the repo and built Angular bundle for secret shapes (Discord token `[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`, `hooks.slack.com/services/`, `postgres://…:…@`, `AIza…`) — see the verification list in `CLAUDE.md`.
