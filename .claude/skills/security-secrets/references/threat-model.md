# Threat model (STRIDE-lite) for The Report Line

Walk each boundary the data crosses and ask the six STRIDE questions: **S**poofing (who is this really?), **T**ampering (can it be altered in flight/at rest?), **R**epudiation (can an actor deny what they did?), **I**nformation disclosure, **D**enial of service, **E**levation of privilege. Keep this table current: a new endpoint class, integration or stored secret means a new row or a changed cell, and the matching test in the quality-bar list.

| Boundary | Threat | Defence in this design | Verified by |
|---|---|---|---|
| Internet → `POST /interactions` | **S** forged request pretending to be Discord | Ed25519 over `timestamp + rawBody` before parse or side effect; bare 401 | Attack suite: tampered body/timestamp, missing headers, bad hex |
| | **T** body altered after signing | Verify over raw bytes, never re-serialised JSON | Tampered-body test |
| | **T** replay of a valid captured request | 5-minute timestamp window + `interaction.id` PK dedupe | Stale-timestamp test; 10 concurrent duplicates → one row/job/post |
| | **D** flood of junk / huge bodies | Body size limit; verify first (cheap, no DB); rate-limit by IP at the edge where available | Oversized-body test; bad signature never touches DB |
| | **I** error text leaks internals | Bare 401, generic 500, no stack | Review of error handler |
| Browser → `/api/*` (admin) | **S** stolen/guessed session | Opaque ≥128-bit id, hashed at rest, HttpOnly+Secure+SameSite=Lax, rotation on login, idle+absolute expiry | Cookie flag test; login rate-limit test |
| | **T** CSRF on mutations | Per-session token in `X-CSRF-Token`, constant-time compare, 403 on mismatch | CSRF test |
| | **E** IDOR — admin A reads/changes guild B | `TenantGuard` + `guild_id` and `admin_guild` in every query; 404 not 403 | Cross-tenant test per endpoint |
| | **D** brute force / hammering | Login limiter, global `/api` limiter, small body limit | Rate-limit tests |
| | **I** secrets in responses | Webhook URL write-only (`last4` only); token never in DTOs | Response-shape snapshot of DTO schemas |
| | **R** admin denies changing config | Security-event log lines (actor, ip, resource, result) for login/logout/config/webhook/retry — see `observability` | Log assertion tests |
| Worker → Slack/Discord webhooks | **S/E** SSRF through admin-supplied URL | Host allow-list, https only, no creds/port, `redirect: 'manual'`, re-validated at send | SSRF unit tests (internal IP, `@` trick, lookalike host, redirect) |
| | **I** webhook URL leaks | AES-256-GCM at rest, decrypt only in worker, redacted logs, never in errors | Grep + redaction test |
| | **D** slow/hung downstream starves the worker | `AbortSignal` timeout on every call, bounded concurrency, lease recovery | Stub slow/down test |
| User text → Discord/Slack | **T/E** `@everyone` pings, link spoofing, markup injection | `allowed_mentions: {parse: []}`, Slack escaping, truncation | Mention-injection test |
| User text → LLM | **E** prompt injection steers the output | Text delimited as data; JSON schema/enum validation; fallback tag; model output can never trigger an action | Injection-string test → fallback tag, mirror still sent |
| App → Postgres | **T** SQL injection | Parameterised queries only; no dynamic identifiers | Lint rule + review; injection payload test |
| | **I** connection string / raw errors leak | Env only; redacted logs; generic API errors | Grep + redaction test |
| | **D** pool exhaustion | Small pool, connection + statement timeouts | Load smoke test |
| Build/deploy → host | **T** malicious or hallucinated dependency | Verify names, lockfile, `npm ci`, `npm audit`, review diffs | Audit step in deploy checklist |
| | **I** secrets in repo or bundle | `.env` ignored, hooks block writes, secret grep over repo and built bundle | Grep step in verification list |
| Dashboard SPA (browser) | **T/E** XSS via logged user text | Angular escaping, no `bypassSecurityTrust*`/`innerHTML`, CSP | Render a `<script>`/`<img onerror>` report in the log; verify inert |
| | **I** tokens in browser storage | Cookie-only session; nothing sensitive in `localStorage`/`environment.ts` | Bundle grep |

## Residual risks to record (not hide)

State these honestly in the README/AI notes instead of pretending they're solved:
- The seeded throwaway admin credential is a deliberate weakness of the demo; rotate or remove after grading.
- Free-tier hosting means no WAF/DDoS protection; the rate limits are best-effort.
- A compromised bot token or Discord public key outside this app is out of scope; the incident path is: rotate the token in the Developer Portal, update the host env, redeploy.
- Interaction tokens live up to 15 minutes in the DB (cleared on completion/expiry); a DB breach in that window exposes them.

## Incident path (one line each, keep in README)

Leaked bot token → reset in Developer Portal + host env. Leaked webhook URL → delete webhook in Slack, replace in dashboard. Leaked `WEBHOOK_ENC_KEY` → generate new key, re-encrypt (or have admins re-enter) every stored webhook. Suspected session theft → delete rows in the `session` table, rotate `SESSION_SECRET`.
