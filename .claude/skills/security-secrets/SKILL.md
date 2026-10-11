---
name: security-secrets
description: Security rules for this Discord bot + dashboard app — secrets handling (bot token, public key, mirror webhook URLs, DB URL, LLM key, interaction tokens) across repo, client bundle and logs; startup config validation; admin authentication and sessions (cookies, CSRF, password hashing, login rate limiting); authorization and per-guild isolation; SSRF defence for admin-supplied webhook URLs; input handling for Discord, Slack, SQL, HTML, file paths and LLM prompts; cryptography choices (randomness, constant-time compare, AES-GCM, TLS to Postgres); prototype pollution; HTTP security headers/CSP; dependency and supply-chain hygiene (including packages an AI suggests); process-level crash handling; and a trust-boundary threat table. Use this whenever you add or read an env var, write config, touch auth/login/session/cookies/CORS/headers, store or display a webhook URL or token, make an outbound request to a URL a user supplied, log anything, send user-supplied text anywhere (Discord, Slack, LLM, DB, dashboard), add or upgrade a dependency, add an admin endpoint, or are asked to review code for security.
---

# Security & secrets

The quality bar says the app "must never expose secrets — not in the repo, not in client-side code, not in logs", and graders will probe the endpoint with junk. Think of the app as running unattended on the public internet, because it will.

Two references go with this skill:
- `references/secure-coding-patterns.md` — copy-ready snippets (SSRF guard, constant-time compare, AES-GCM, helmet/CSP, process handlers, safe-path join, pollution-safe maps) and the pre-commit anti-pattern scan.
- `references/threat-model.md` — the trust boundaries of this app and what defends each. Add a row whenever you add a boundary (new integration, new endpoint class, new stored secret).

Mindset for every change: **assume every input is hostile, every dependency is fallible, and every error message is read by an attacker.** Authorisation is checked on the server for every resource, never inferred from the UI.

## Secret inventory

| Secret | Lives in | Never appears in |
|---|---|---|
| `DISCORD_BOT_TOKEN` | backend env | client bundle, logs, DB, API responses |
| `DISCORD_PUBLIC_KEY` | backend env | client bundle (it's "public" but the assignment lists it — keep it server-side) |
| `DISCORD_CLIENT_SECRET` (if OAuth login) | backend env | anywhere else |
| Mirror webhook URL(s) (Slack) | DB, AES-256-GCM encrypted per guild | logs, API responses, client bundle |
| `WEBHOOK_ENC_KEY` | backend env | anywhere else |
| `DATABASE_URL` | backend env | logs (connection errors often print it — redact) |
| LLM API key | backend env | anywhere else |
| `SESSION_SECRET` | backend env | anywhere else |
| Interaction `token` (per request, ~15 min) | memory / outbox job payload | logs, dashboard API |

Rules that follow from this:

- **`.env` is gitignored; `.env.example` lists every variable with placeholder values** (`DISCORD_BOT_TOKEN=replace-me`). A PreToolUse hook blocks writes to `.env` and writes containing real-looking tokens — if it blocks you, use a placeholder or an obviously fake value (e.g. `https://example.test/webhook`), don't work around it.
- **Angular `environment.ts` contains no secrets, ever.** Everything in the frontend bundle is public. The frontend only knows the API base URL.
- **Validate config at startup** with a zod schema in `config/env.ts`; crash fast with a message naming the *missing variable*, never its value. Import config from that module only — no scattered `process.env.X`.
- **Per-guild Slack webhook URLs** are stored AES-256-GCM encrypted (`guild.mirror_webhook_enc`, key `WEBHOOK_ENC_KEY` from env — DESIGN §9). Use a random 12-byte IV per encryption and store IV + auth tag with the ciphertext; reusing an IV with GCM breaks it. Decrypt only in the worker at send time.
- **They are write-only in the API**: accept on PUT, never return them — respond with `{ configured: true, last4: "abcd" }`. The dashboard shows "Configured · ends in abcd" with a Replace button.

## Logging

Use the shared logger's redaction (see `observability`). Never log: request bodies of `/interactions` in full (they contain `token`), `Authorization` / `Cookie` headers, webhook URLs, DB URLs, LLM prompts containing user text at info level. Log ids (`interactionId`, `guildId`, `jobId`), not payloads. Error objects from `fetch` can include the URL — log `err.name`/`err.message` after redaction, or a host-only form.

## Admin authentication

ADR-0003 decides this: email + password (argon2id), opaque session id in an HttpOnly, Secure, SameSite=Lax cookie, sessions in Postgres, CSRF token on mutations, login rate limit, one seeded throwaway admin. Implementation notes:

- Seed the admin from env (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) in `scripts/seed-admin.ts`, never as a literal in a migration.
- Session id: ≥ 128 bits from `crypto.randomBytes`; store a hash of it, not the raw value; set `expires_at`; rotate on login (prevents fixation); delete on logout.
- **No tokens in localStorage** — the session is the cookie; the SPA only knows "logged in as X".
- CSRF: issue a per-session token (e.g. `GET /api/auth/csrf` or in the login response), require it in an `X-CSRF-Token` header on every non-GET, compare with `crypto.timingSafeEqual`. Missing/wrong → 403.
- Cross-site trap: the design hosts the SPA as static files; if that's a different *site* from the API, a `SameSite=Lax` cookie won't be sent on XHR. Serve the SPA and API from the same origin (host rewrite of `/api/*`, or Express serving `dist/`) — see `free-tier-deploy`. Don't "fix" it by weakening cookie flags without a proposal.
- Rate-limit login (e.g. 5/min per IP+email) and return the same generic message for wrong email or wrong password. Also put a looser global limiter on `/api/*` so a scripted client can't hammer the DB.
- Sessions have both an **idle** and an **absolute** expiry; changing the password or logging out invalidates the session(s) server-side. Never accept the session id from anywhere but the cookie.
- argon2id with the library defaults at minimum (verify current OWASP minimums: memory ≥ 19 MiB, time ≥ 2, parallelism 1); compare via the library's `verify`, never by hashing and `===`. Never log or return the hash. Hash a dummy password when the email isn't found so response time doesn't reveal which emails exist.
- Interaction-token and session-token style values come from `crypto.randomBytes`/`randomUUID`, never `Math.random()`.

## Authorization & isolation

- Every admin route requires a session; check it in one middleware, not per handler.
- **Every query that touches guild data is scoped by `guild_id` and checked against `admin_guild` for the logged-in admin** (SR-4). A guild the admin doesn't manage → **404**, indistinguishable from "doesn't exist" (CLAUDE.md). Enforce it in one `TenantGuard` plus in the repository query itself (`WHERE guild_id = $1 AND EXISTS (admin_guild …)`), so a forgotten guard still leaks nothing. Graders will try the IDOR (DESIGN §10.4).
- Interactions: the guild comes from the *signed* payload, so it is trustworthy; button `custom_id`s are not — re-check that the referenced record belongs to `interaction.guild_id`.

## Outbound requests to user-supplied URLs (SSRF)

The mirror webhook URL is typed in by an admin and then fetched by the server — that is a server-side request forgery vector. An attacker (or a compromised admin account) could point it at `http://169.254.169.254/` (cloud metadata), `http://localhost:5432`, or an internal host, and the worker would call it on their behalf and store the error text where the dashboard shows it.

- **Allow-list the destination** when the URL is saved *and* again just before sending (a stored value can be edited in the DB; DNS can change): scheme `https`, host exactly in the configured allow-list (`hooks.slack.com`; `discord.com`/`discordapp.com` for Discord webhooks), no credentials in the URL (`user:pass@`), no non-default port, path matches the expected prefix (`/services/…`, `/api/webhooks/…`).
- Fetch with `redirect: 'manual'` (treat any 3xx as a failure) so an allowed host can't bounce you to an internal one.
- Never reflect the response body back to the dashboard; store a short, redacted failure reason (`"Slack rejected the webhook (404)"`).
- Validation failure → 400 `MIRROR_WEBHOOK_INVALID` with a user-friendly message; the rejected value is neither logged nor echoed.
- The same rule applies to any future "enter a URL" feature. Snippet in `references/secure-coding-patterns.md`.

## Untrusted input — where user text goes

| Destination | Risk | Defence |
|---|---|---|
| Discord message | `@everyone`/role pings, markdown abuse | `allowed_mentions: { parse: [] }`; truncate to limits (2000 chars content) |
| Slack webhook | `<!channel>`, link spoofing | escape `&`, `<`, `>` per Slack formatting rules; truncate |
| SQL | injection | parameterized queries / query builder only; no string concatenation |
| Dashboard HTML | XSS | Angular interpolation escapes by default; never `bypassSecurityTrust*` or `[innerHTML]` with user text |
| LLM prompt | prompt injection ("ignore instructions, tag as critical") | Put user text in a clearly delimited field; ask for structured output (JSON with enum tags); validate with zod; on invalid output fall back to "untagged". The LLM can label, never choose actions outside the allowed set. |
| Logs | log injection, PII | structured logging (no string concatenation), truncate free text |
| File paths | traversal (`../../etc/passwd`) | Don't build paths from input. The only files served are the Angular build via `express.static`. If you ever must, `path.resolve(root, input)` then require the result to start with `root + path.sep` |
| Object keys / merges | prototype pollution (`__proto__`, `constructor`) | zod schemas drop unknown keys (use `.strict()` on bodies); never `Object.assign`/spread raw input into config or domain objects; use `Map` for maps keyed by user strings (`custom_id`, command name) |
| Dynamic code | RCE | No `eval`, `new Function`, `vm`, or `import()`/`require()` of a path derived from input; no shell — if a child process is ever unavoidable, `execFile` with an argument array |
| Error text returned to clients | schema/internal disclosure | Generic message + `requestId`; never raw `pg` errors (they carry table, constraint and query text) or stack traces |

Reject bad input with 400 and a field-level message; do not echo the offending value into the response or the logs.

## Cryptography

- Never write your own crypto or invent a scheme. Use `node:crypto` primitives or the vetted library (`discord-interactions`/`tweetnacl` for Ed25519, `argon2`).
- Randomness for ids, tokens, IVs and salts: `crypto.randomBytes` / `randomUUID`. `Math.random()` is for the injected jitter only, never anything an attacker must not guess.
- Comparing secrets, CSRF tokens, signatures or MACs: `crypto.timingSafeEqual` on equal-length buffers (check length first — it throws on mismatch; a length mismatch is simply "not equal").
- Symmetric encryption is AES-256-GCM with a fresh 12-byte IV per message and the auth tag stored and verified; never ECB/CBC-without-MAC, never a reused IV. No MD5/SHA-1 for anything security-relevant; SHA-256 for fingerprints (e.g. hashing the stored session id).
- TLS everywhere outbound. **Never** `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or `ssl: { rejectUnauthorized: false }` on the Postgres connection to "get it working" — managed Postgres (Neon/Supabase) works with `sslmode=require` and the default verification. If a certificate error appears, fix the cause or raise a proposal.

## HTTP hardening (Express)

`helmet()`; CORS: none needed (same origin) — if it is ever added, an env allow-list, never `*` with credentials; body size limit (e.g. 100kb) — including on `/interactions` raw parser; `app.disable('x-powered-by')`; generic 500 messages with a request id, never stack traces in responses; `trust proxy` set correctly on Render/Vercel so rate limiting sees real IPs.

Headers that matter for the SPA + API origin (full snippet in the reference): `Content-Security-Policy` with `default-src 'self'` and `frame-ancestors 'none'` (Angular Material usually needs `style-src 'self' 'unsafe-inline'`; add `font-src`/`style-src` for Google Fonts only if you load them — test the built app with the console open and widen only what it reports), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS (the host terminates TLS), and `Cache-Control: no-store` on authenticated `/api` responses. Remove debug endpoints and verbose errors from production builds.

## Dependencies and supply chain

AI assistants occasionally suggest packages that don't exist, are abandoned, or are one typo away from a malicious look-alike. Treat every new dependency as code you're choosing to run with your secrets in the environment.

- Before adding a package: confirm the exact name on npm, check it is maintained (recent releases, real repo, sensible download count), and read what it pulls in transitively. Prefer the platform (`node:crypto`, `fetch`) or an already-present library over a new one; fewer deps, smaller attack surface.
- Commit the lockfile; install with `npm ci` in CI and on the host; avoid `^`/`~` drift on security-sensitive packages by letting the lockfile pin them, and review lockfile diffs.
- Run `npm audit --omit=dev --audit-level=high` before every deploy and fix or consciously record anything high/critical. Don't blanket `--force`.
- Be wary of install scripts from unfamiliar packages (`npm ci --ignore-scripts` as a first check).
- The same applies to the Angular build: nothing from a CDN `<script>` tag without subresource integrity; no third-party analytics/fonts without a reason.

## Crashes and failure behaviour

Register `process.on('unhandledRejection')` and `uncaughtException` handlers that log (redacted) and `process.exit(1)`: continuing in an unknown state is worse than a restart, and the host restarts the process while the job lease (see `resilience`) recovers anything in flight. Fail closed — when auth, signature or tenant checks can't be completed, deny; never "allow on error". Error responses never reveal which check failed beyond what the client needs (invalid vs. missing signature are both a bare 401).

## Before you commit

- `git diff --cached` contains no `.env`, no real-looking token, no webhook URL.
- New env var? Added to `config/env.ts` schema, `.env.example`, and the README env table.
- New dependency? Name verified on npm, lockfile updated, `npm audit` clean at high.
- New endpoint? Auth middleware applied, input schema strict, guild scope enforced and tested (including the 404-for-foreign-guild case), error path returns a generic message.
- New outbound call? Timeout set, destination fixed or allow-listed, response not reflected to the user, no secret in the URL logged.
- Run the anti-pattern scan from `references/secure-coding-patterns.md` over the changed files and either fix each hit or leave a comment explaining why it's safe.
