---
name: resilience
description: How to implement the reliability design (transactional outbox, SKIP LOCKED worker with claimed_at leases, retry classification, full-jitter backoff, job_attempt history, 15-minute token fallback) correctly in code, plus timeouts on every outbound call, graceful degradation, the internal AppError model and the API error response shape the frontend relies on. Use this whenever you write code that calls an external service (Discord REST, Slack webhook, LLM, database), handles failures or retries, writes or changes the worker/ledger, defines error codes or API error responses, or when asked "what happens if X is down", about duplicates, or timeouts.
---

# Resilience & error handling

Three items in the grading quality bar are unhappy paths: duplicate delivery, a downstream briefly down, slow work. The architecture already answers all three with one mechanism — **ADR-0001 (outbox in Postgres)**, the job lifecycle in **DESIGN §11.1**, the failure catalogue in **§14**, and the contracts in **§8** (`LedgerService.recordAndEnqueue`, `classifyFailure`, `nextBackoffMs`). Read those for *what*; this skill is about getting the *code* right, where these designs usually break.

## Request path: record, enqueue, respond — in that order

- `recordAndEnqueue` is one transaction: `INSERT interaction … ON CONFLICT (id) DO NOTHING RETURNING id`, then, only if a row came back, `INSERT job`. Use a single client checked out from the pool for both statements — two `pool.query` calls are two connections and **not** one transaction (a classic AI-generated bug).
- `'duplicate'` → no job, no side effect; reply with an equivalent response.
- Respond to Discord only after the commit returns. If the DB is down you cannot record, so you cannot promise anything: send an immediate ephemeral "We couldn't log that right now — please try again in a minute" and log an error. Discord doesn't redeliver interactions; an honest message beats a fake success.
- After commit, nudge the worker (in-process signal) so the user isn't waiting for the next poll tick.

## Worker: the parts that are easy to get wrong

- **Claim** with `FOR UPDATE SKIP LOCKED` inside a transaction that also sets `claimed_at = now()` and increments `attempts`, then commit *before* doing network I/O. Holding the row lock during a 5-second Slack call ties up a connection and blocks nothing useful.
- **Lease recovery**: jobs whose `claimed_at` is older than the lease (> max call timeout + margin) count as claimable again (DESIGN §11.1). Test it by claiming and never finishing.
- **Attempt history**: insert a `job_attempt` row for every attempt with `started_at`, `finished_at`, `outcome`, `http_status`, and a redacted `error`. This is the dashboard's retry history (F-10) — write it even on success.
- **Finish** in one statement per outcome: done (clear `interaction_token`), retry (`status='pending'`, `next_run_at = now() + backoff`, `last_error`), dead (clear token, keep visible).
- **Token clock**: before using the interaction token, check `token_expires_at`. Past it → don't call the webhook; take the design's fallback (post to the guild's channel with the bot token).
- **Concurrency**: claim up to N jobs (design: concurrency 5) and process with `Promise.allSettled`, so one hanging job never stalls the rest.
- **Shutdown**: on SIGTERM stop claiming, let in-flight calls finish or time out. Anything unfinished is recovered by the lease.

## Every outbound call

```ts
await fetch(url, { method, headers, body, signal: AbortSignal.timeout(config.SLACK_TIMEOUT_MS) });
```

- No timeout = bug (CLAUDE.md). Suggested defaults: 5s for Discord/Slack, 15s for the LLM.
- Adapters translate every failure into `{ status?: number; kind?: 'timeout' | 'network' }` (a `TimeoutError`/`AbortError` → `timeout`, a `TypeError: fetch failed` → `network`), so the pure `classifyFailure` decides. Don't let raw `fetch` errors leak past the adapter.
- 429: honour `Retry-After` / Discord's `retry_after` as the next attempt time instead of computed backoff.
- Base URLs and timeouts come from config, so tests and the quality verifier can point them at `stub-downstream.mjs`.
- The database is an outbound dependency too: configure the `pg` pool's `connectionTimeoutMillis` and `idleTimeoutMillis`, and set `statement_timeout` (and `idle_in_transaction_session_timeout`) so a stuck query or an abandoned transaction can't pin a connection indefinitely. Always release the client in `finally`.
- Bound everything that can grow: concurrency (N claimed jobs), batch size, response bodies you read from downstream (don't buffer an unbounded body — check `content-length`/cap it), in-memory queues and caches. Unbounded growth is how a free-tier instance dies quietly.
- Cross-cutting process safety (unhandled rejections, shutdown) is in `security-secrets` → *Crashes and failure behaviour*; startup must not block on slow dependencies (listen first, warm up after) so the host's health check and the 3-second window both pass on a cold start.
- Backoff is the design's full jitter, `rnd() * min(maxMs, baseMs * 2 ** attempt)`, with `rnd` injected so tests are deterministic. Cap attempts; exhausted → dead.

## Degrade, don't fail

- LLM tagging is best-effort (CLAUDE.md): on timeout/invalid output use the fallback tag and continue — the mirror and the Discord reply still happen.
- A failing mirror must not change what the Discord user sees beyond an honest "notification delayed" if you choose to show it.
- Fatal failures (4xx except 429: deleted webhook, missing permissions, bad payload) go dead immediately with a reason a human understands — the dashboard shows it.

## Errors inside the app

- One `AppError` class: `{ code: string; status: number; message: string; retryable?: boolean; cause?: unknown; context?: Record<string, unknown> }`, thrown from `app/` services. Never throw strings. `code` values come from one `as const` map in `packages/shared` (so the frontend can switch on them); `context` carries ids useful for debugging (`guildId`, `jobId`) — never secrets or user text.
- `http/middleware.ts` has the single error handler: map `AppError` → response, unknown → 500 `INTERNAL` with a generic message, log once with `requestId`. Don't log the same error at every layer.

Who does what with a failure, so it is handled exactly once:

```
adapter  → catches the library/network error, returns or throws a port-level failure ({status?, kind?}) with cause attached
app      → adds business context only if it has some to add (wrap with cause), otherwise lets it propagate; does not log
edge     → the Express error handler (HTTP) or the worker loop (jobs) classifies, logs ONCE with ids, and shapes the response / records the job_attempt
```

A `try/catch` that only logs and rethrows is a duplicate log line; a `catch` that swallows without recording an outcome is a lost failure. Both are bugs. Check idempotency before retrying anything that writes — the Discord PATCH-edit and the keyed outbox row make retries safe; a bare POST to a webhook does not, which is why one `job` produces at most one mirror post.

### Infrastructure error codes worth handling explicitly

| Source | Code | Meaning | Handling |
|---|---|---|---|
| Node network | `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_*` / `TypeError: fetch failed` | transient network failure | adapter → `{ kind: 'network' }` → retry with backoff |
| Node abort | `TimeoutError` / `AbortError` | our `AbortSignal` fired | `{ kind: 'timeout' }` → retry |
| Node process | `EADDRINUSE` at startup | port taken | log and exit(1) — don't retry-loop |
| Postgres | `23505` unique_violation | duplicate | intended path for dedupe (`ON CONFLICT`); elsewhere map to 409 |
| Postgres | `23503` foreign_key_violation / `23514` check_violation | a bug or bad reference | 4xx/500, never retry |
| Postgres | `40001` serialization_failure, `40P01` deadlock_detected | transaction conflict | retry the whole transaction a small bounded number of times |
| Postgres | `57014` query_canceled (statement timeout), `08xxx` connection exceptions, `57P01` admin shutdown, `53300` too_many_connections | DB unavailable/overloaded | request path: honest "try again" reply, `/readyz` 503; worker: leave jobs pending |

HTTP statuses: retry 408, 425, 429, 500, 502, 503, 504 (plus timeouts/network); treat other 4xx as fatal — the single `classifyFailure` function owns this, nobody re-implements it inline.

Never let a raw `pg` error reach a client: it contains table, constraint and query text.
- Express 5 forwards rejected promises from async handlers to the error middleware — confirm against the installed version; on Express 4, wrap handlers.
- Validation (zod) → 400 `VALIDATION_FAILED` with field-level `details` the frontend can attach to form fields.
- The `/interactions` route never returns a 500 for bad input — signature failures are 401 before anything else runs (SR-1).

API error shape (the design doesn't define one, so this is the contract — keep it in `packages/shared`):

```json
{ "error": { "code": "MIRROR_WEBHOOK_INVALID", "message": "That webhook URL was rejected by Slack.", "details": { "field": "mirrorWebhookUrl" }, "requestId": "req_7f3a" } }
```

`code` is stable and machine-readable (the frontend switches on it); `message` is already user-friendly (`user-facing-messages`); `requestId` matches a log line.

## Tests that prove it (map to build-plan Steps 2–3)

- 10 concurrent identical signed interactions → one interaction row, one job, one Slack post, one reply.
- Kill between commit and ACK → job survives and is processed.
- Slack stub 500 then 200 → two `job_attempt` rows, one mirror post, deferred reply filled.
- Slack stub 404 → dead after one attempt with a readable reason.
- Slack stub down for longer than several backoff cycles, then up → all jobs drain, none doubled.
- `token_expires_at` in the past → channel fallback via bot token, no webhook call.
- Claimed job never finished → recovered after lease expiry.
