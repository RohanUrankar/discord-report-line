---
name: observability
description: Structured logging, redaction, correlation ids, security-event vs operational log classification (login, tenant denial, config changes, signature rejections), health checks and the persisted event/attempt history that powers the dashboard's live log and failure/retry view, for the Node/Express backend. Use this whenever you add logging, create or modify the logger, add a health endpoint, record what happened to an interaction (received, responded, mirrored, retried, failed), design the events/attempts tables or the log API the dashboard reads, or debug a production issue from logs.
---

# Observability

Two separate things, often confused:

1. **Operational logs** (stdout, for you debugging on Render): structured JSON, high volume, ephemeral.
2. **Product history** (Postgres, for the admin's dashboard): a curated record of each command and every action taken, including failures and retries. This is a feature graders will click through ("shows a live log of every command and action"; "a visible history of failures and retries").

Don't build #2 by scraping #1.

## Logger (pino)

One logger in `lib/logger.ts`; child loggers carry context.

```ts
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.webhookUrl',
            '*.password', '*.botToken', '*.databaseUrl', '*.apiKey'],
    censor: '[redacted]',
  },
});
```

- Per request: a `requestId` (from `x-request-id` or generated), attached via child logger and returned in the response header and error bodies.
- Per interaction: child with `interactionId`, `guildId`, `command`, `interactionType`.
- Per job attempt: `jobId`, `kind`, `attempt`, `durationMs`, `outcome`.
- Messages are stable event names (`interaction.received`, `interaction.rejected`, `job.retry_scheduled`, `job.dead`) with fields — easy to grep, easy to count.
- Levels: `error` = needs a human (job dead, DB down); `warn` = expected bad input (bad signature, 429); `info` = lifecycle events; `debug` = payload details (never in prod).
- Never log full interaction bodies, webhook URLs, tokens, or LLM prompts at info. Add a unit test that the redaction paths actually redact a sample object.
- Use `pino-pretty` only in dev via a script flag, not in prod.

## Security events vs operational logs

Some log lines are an audit trail ("who did what to which resource, and did it work?"); most are not. Classify every new `logger.*` call, because security events need a stable shape, are never sampled away, and are the first thing read after an incident.

Decision rule: **is it triggered by a user/admin action or a security-relevant state change?** Yes → security event (`logType: 'security'`). No (debug traces, internal calls, routine I/O, polling that changed nothing) → operational.

Always security events:
- Admin auth: `auth.login.succeeded`, `auth.login.failed`, `auth.logout`, `auth.session.expired`, `auth.csrf.rejected`, rate-limit hits on login.
- Authorisation: `tenant.access_denied` (admin asked for a guild they don't manage → still 404 to the client, but logged with the admin id and the guild id attempted).
- Configuration changes: command rule created/updated/deleted, mirror webhook replaced (log *that* it changed and `last4`, never the URL), server connected/disconnected.
- Operator actions on jobs: manual retry, dismiss, purge.
- Inbound request rejection: `interaction.signature.rejected` (warn — rate-limit or sample this one; an attacker can flood it to bloat your logs), stale/replayed timestamp.
- Integrity failures: webhook ciphertext failed to decrypt, startup config invalid.

Shape (pino merging object first, then the stable message):

```ts
logger.info({
  logType: 'security',
  event: 'config.webhook.replaced',   // stable, dotted, greppable
  actor: { adminId },                  // 'system' for worker-initiated events
  src: req.ip,                         // omit if unknown
  resource: { guildId },
  result: 'success',                   // 'success' | 'failed'
  reason: undefined,                   // short code on failure, e.g. 'validation_failed'
}, 'config.webhook.replaced');
```

Rules:
- Operational lines omit `logType: 'security'`; don't invent security fields on them.
- Security events contain no secrets, tokens, webhook URLs, passwords, or free user text — ids and short reason codes only. Redaction still applies as defence in depth.
- Don't add a path that disables, truncates or bypasses these logs without it being a security event itself and admin-gated.
- If the dashboard should *show* an admin audit trail, that's a data-model change → proposal (don't repurpose `interaction`/`action`). Until then these lines live in the operational log stream and are described in the README.
- Add a test that each security event is emitted with the expected `event`, `result` and no secret fields (login success/failure, foreign-guild 404, webhook replace).

## Product history (DESIGN §9 tables)

The design already models it — use these, don't add a parallel events table:

- `interaction` — what arrived (id, guild, channel, user, type, command, custom_id, options, status).
- `action` — what the bot did about it (type, summary, `llm_tag`, `mirror_status`).
- `job` + `job_attempt` — the async work and **every attempt** (outcome, http_status, error, started/finished). This is the "visible history of failures and retries" (F-10, NFR-07).

The dashboard's row = interaction + action; its expandable timeline = the job's attempts in order ("attempt 1 · 503 from Slack · retry in 4s" → "attempt 2 · ok"). `job_attempt.error` is written for a human admin and already redacted. If a step needs data these tables can't hold, that's a proposal, not a new table.

Retention: the design's periodic sweep clears expired tokens and prunes old done jobs; mention it in the README.

## Live log API

Shape suggestions where DESIGN doesn't specify (record what you choose as an Assumption so the frontend agent sees it):

- `GET /api/guilds/:guildId/interactions?before=<cursor>&limit=50` — history, newest first (uses the `interaction (guild_id, created_at DESC)` index).
- `GET /api/guilds/:guildId/interactions?updatedAfter=<ts>` — polling: new rows *and* rows whose job/action changed, so "retrying" turns into "delivered" on screen. SSE (Step 6 toggle) pushes the same payloads.
- `GET /api/guilds/:guildId/failures` — dead jobs and recent failures, so the admin sees problems without scrolling.
- All tenant-scoped (404 for guilds the admin doesn't manage). Responses include only display-safe fields — never `interaction_token`, never webhook URLs.

## Health

- `/healthz` → 200 `{status:'ok'}` without touching dependencies (used by keep-alive pingers and Render).
- `/readyz` → checks DB with a short timeout; 503 when unavailable.
- Optionally expose worker lag (age of oldest pending job) in `/readyz` and on the dashboard — it's the single most useful "is it healthy?" number.
