# CLAUDE.md — The Report Line (coding agent instructions)

Read `DESIGN.md` for the full architecture. This file is the short list of invariants. Do not violate them to "get it working". When in doubt, prefer the DESIGN.md behaviour.

## Stack (fixed)
- Backend: Node.js + TypeScript + Express. Dashboard: Angular SPA. DB: PostgreSQL only (no Redis, no broker, no second datastore).
- One deployable: HTTP server + in-process worker loop. Worker also runs standalone via `WORKER_MODE=standalone`.
- Keep `domain/` and `app/` free of Express, `pg`, and `fetch`. I/O goes behind `ports/` interfaces with `adapters/` implementations. See the module tree in DESIGN.md §7.
- `domain/` imports only `domain/`, `@report-line/shared`, `zod`, and `node:crypto` (in `signature.ts` only). Lint enforces this as a strict allow-list. `packages/shared` is a leaf: it imports only `zod`, never `apps/*` or `node:*`. Enums, rule schemas and `DEFAULT_RULES` are defined there once; `domain/types.ts` re-exports the enums.

## Non-negotiable invariants

**Signatures (verify before anything).**
- Verify Ed25519 over `timestamp + rawBody` using the app public key on EVERY inbound request, before parsing or any side effect. Use `discord-interactions` `verifyKey` (or `tweetnacl`/`node:crypto`).
- Invalid, missing, or malformed signature → HTTP **401**, no body, no side effect. Malformed input (bad hex, wrong length, empty body) must return 401, NEVER throw a 500. Validate hex + exact lengths, wrap in try/catch, return false.
- Mount `express.raw({type:'application/json'})` on `/interactions` ONLY, before any global `express.json()`. The signed body is the raw bytes; never verify over re-serialised JSON.
- After verifying, reject requests whose `X-Signature-Timestamp` is older than 5 minutes (replay).

**Interaction handling order:** verify → parse → if type 1 (PING) return `{type:1}` with `Content-Type: application/json` and stop → else dedupe + outbox → reply. A PING has no `member`/`data`/`guild_id`; never read those on a PING, never store a PING.

**Dedupe + durability (exactly-once effect).**
- Dedupe with ONE statement: `INSERT INTO interaction (...) ON CONFLICT (id) DO NOTHING RETURNING id`. Row = won, no row = duplicate. Never SELECT-then-INSERT.
- Insert the `job` row in the SAME transaction as the interaction (outbox). Persist before you ACK Discord.
- `interaction.id` (Discord id) is the PK and the dedupe key. `job.interaction_id` is unique.

**The 3-second / 15-minute clocks.**
- Send the initial response within 3 s. Do NO slow work (LLM, Slack, multi-query) before the reply/defer.
- Slow work → respond type 5 (defer) now, do the work in the worker, then `PATCH /webhooks/{app_id}/{token}/messages/@original`. Do not use POST-followup to fill a deferred reply: Discord documents that edit-original side effect as deprecated, and a retried POST creates a duplicate message where a retried PATCH is idempotent.
- A modal (type 9) must be the IMMEDIATE response to a command/component; you cannot defer then modal. Modal is not valid for PING or MODAL_SUBMIT.
- After 15 min the token is dead → fall back to a channel post via the bot token. A follow-up 401/404 is fatal (never retried): clear the token and take the same fallback immediately. The fallback is public, so it never includes the report text of an ephemeral report (DESIGN §11.3).

**Worker / retries.**
- Claim with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n`. Treat a claim as a lease (`claimed_at`); expired lease → job returns to pending (crash recovery).
- Every outbound call has an `AbortSignal` timeout. A call with no timeout is a bug.
- Retry ONLY: timeouts, network errors, 5xx, 429 (next attempt no earlier than `Retry-After`; never cap it down). 4xx (except 429, and including 408/425) is fatal → mark dead now. Exhausted attempts → dead, kept visible. One `classifyFailure` decides; nobody re-classifies inline.
- One job per interaction. Steps run tag → mirror → follow-up/fallback, each skipped if its marker (`ACTION.llm_tag`, `ACTION.mirror_status='sent'`) is already set. Never mark `done` or clear the token before the follow-up succeeds.
- Backoff with full jitter: `rnd() * min(maxMs, baseMs * 2 ** attempt)`. Record every attempt in `job_attempt`.

**Secrets.**
- Bot token, app public key, Gemini key, webhook encryption key: env only, never in the repo, client bundle, or logs. Provide `.env.example` with placeholders.
- Per-tenant Slack webhook URL: store AES-256-GCM encrypted in the DB (`mirror_webhook_enc`), key from env.
- Interaction token: its own `job` column, cleared when done/expired, never logged, never indexed, never in audit JSON. Structured logs redact it.
- Logger: **pino** with `redact` covering the interaction-token field and any `authorization` header; child logger keyed on `interaction_id` for correlation. Never hand-roll redaction, and never `console.log` a raw request or secret.

**Tenancy (multi-server from day one).**
- Every dashboard query is scoped by `guild_id` AND checked against `admin_guild` for the logged-in admin. A mismatched id returns 404, not data, not 403.

**Dashboard auth.**
- argon2id password hash. Opaque session id in an HttpOnly, Secure, SameSite=Lax cookie; sessions in the DB. CSRF token on mutations. Rate-limit login. One seeded throwaway admin.
- SPA and API share ONE origin: Express serves the Angular build (`express.static` + `index.html` fallback for non-`/api` routes). Never deploy the dashboard to a separate static host; a `SameSite=Lax` cookie is not sent cross-site, so login would "succeed" and every API call would 401. No CORS middleware needed or wanted.

**LLM (if enabled).**
- Report text is untrusted. The LLM only tags/summarises. Validate output against a fixed enum; fallback tag on any failure; never let model output trigger an action. Tagging is best-effort; the mirror still happens if tagging fails.

## Verify these before calling anything "done"
- Tests sign payloads with a self-generated Ed25519 keypair: tampered body, tampered timestamp, stale timestamp, missing headers, bad hex → all 401.
- 10 concurrent identical interactions → exactly one row, one job, one Slack post, one reply.
- Slack returns 500 then 200 → attempts recorded, one mirror post, deferred reply filled.
- Admin A requests guild B → 404.
- `grep` the repo and the built Angular bundle for token/secret patterns → nothing.

## Confirm against Discord docs before coding these two
- The exact component JSON type numbers for buttons and text inputs (action row / button / text input) on the Message Components reference. Everything else in DESIGN.md §4 is already verified against docs.discord.com.

## Deliverables the brief requires
README.md (what it does, run locally, env vars, `.env.example`, how/where deployed), AI_NOTES.md (tools/models used, 2-3 decisions you made yourself, the hardest bug the AI led you into and how you caught it, what you'd add next), a test server invite + throwaway admin login, and this CLAUDE.md as your AI context file.

## Agent workflow, skills and hooks
@docs/agent-workflow.md