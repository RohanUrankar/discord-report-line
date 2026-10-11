# 0001 — Retry classification of Discord follow-up 401/404

**Status:** Accepted with amendments, 2026-10-11 (DESIGN rev 2: §8.1, §11.3, §11.4, §14)
**Amendments:** (1) `retryDelayMs` honours `retryAfterMs` **uncapped**; capping at `maxMs` would retry before Discord allows and add to the invalid-request count. (2) On a fatal follow-up the worker clears the token before the fallback. (3) The public fallback never carries the text of an ephemeral report. (4) Found while resolving: §10.2 marked the job done and cleared the token *before* the PATCH; fixed.
**Raised by:** backend-implementer, while implementing `apps/api/src/domain/retry.ts` (`classifyFailure`)
**Blocks:** `classifyFailure` in `domain/retry.ts`; the worker's follow-up branch (Step 3)

## Context

Three sources disagree about how a 4xx from the Discord follow-up (`PATCH /webhooks/{app_id}/{token}/messages/@original`) is handled:

| Source | Says |
|---|---|
| DESIGN §14, row "Discord follow-up · 401/404 (token expired/invalid)" | "if < 15 min, **retry**; else bot-token channel fallback" |
| DESIGN §8.1, `classifyFailure(e: { status?; kind? }): Outcome` | "retryable: timeout, network, 5xx, 429. **fatal: 4xx (except 429)**" |
| CLAUDE.md, Worker / retries | "Retry ONLY: timeouts, network errors, 5xx, 429. **4xx (except 429) is fatal → mark dead now.**" |

The §8.1 signature has no token-age or call-target input, so §14's rule cannot be expressed through it. Implementing §14 as written would mean either changing the §8 contract or having the worker override the classifier inline, which the resilience guidance forbids ("the single `classifyFailure` function owns this").

There is also a smaller, related inconsistency. The `resilience` skill lists **408 and 425** as retryable. CLAUDE.md and §8.1 make every 4xx except 429 fatal.

Facts relevant to the decision:
- A 401/404 on the webhook route within the 15-minute window is deterministic. Common causes are the initial response missing the 3 s window (token invalidated) or a wrong application id. Retrying the same request returns the same error.
- Discord counts repeated 401/403/429 responses toward its invalid-request limit, which leads to a temporary Cloudflare IP ban (https://discord.com/developers/docs/topics/rate-limits#invalid-request-limit-aka-cloudflare-bans). Retrying a deterministic 401 up to `MAX_ATTEMPTS = 8` per job works against that limit.
- A 429 needs its `Retry-After` / `retry_after` delay passed to the scheduler. The §8.1 input `{ status?, kind? }` cannot carry it, and `nextBackoffMs` does not take it.

## Proposal (recommended: Option A)

1. Keep `classifyFailure` exactly as specified in §8.1 and CLAUDE.md: timeout, network, 5xx and 429 are `retryable`. Every other 4xx is `fatal`, **including 401/404 from the follow-up, 408 and 425**.
2. Change the §14 row to: "Discord follow-up · 401/404 · fatal for the webhook route; the worker immediately takes the bot-token channel fallback (the same path used after `token_expires_at`). The job is marked dead only if the fallback also fails fatally."
3. Make one additive change for 429. Extend the classifier input to `{ status?: number; kind?: 'timeout' | 'network'; retryAfterMs?: number }` and add a pure helper to `domain/retry.ts`:
   `retryDelayMs(failure, attempt, baseMs, maxMs, rnd): number`. It returns `retryAfterMs` when present (capped at `maxMs`) and otherwise `nextBackoffMs(...)`. `classifyFailure` and `nextBackoffMs` keep their §8.1 signatures.
4. Update the `resilience` skill so it no longer lists 408/425 as retryable, or add them to CLAUDE.md. Either way the two should agree.

## Options considered

- **A. Fatal, then immediate channel fallback (recommended).** Keeps one classifier and the §8 contract. Avoids retry traffic that counts toward the Cloudflare limit. The user still gets the result in the channel without waiting for 15 minutes. Cost: the §14 row changes, and the fallback post is public rather than ephemeral (already accepted for the >15-min case).
- **B. Implement §14 literally.** Change the §8 signature to `classifyFailure(e, ctx: { target: 'followup' | 'slack' | 'channel'; tokenExpiresAt; now })` and return `retryable` for follow-up 401/404 while the token is alive. This breaks the CLAUDE.md invariant, burns up to 8 attempts on a deterministic failure, and pushes the server toward the invalid-request ban.
- **C. Fatal and dead, no fallback.** Simplest. But the user never sees the outcome of a report that was actually mirrored. This fits the "don't silently lose an interaction" goal poorly.

## Consequences

- The DESIGN §14 row changes, and so does the §10.2 note ("opt token age > 15 min"), which also needs "or the follow-up returned 401/404".
- The §8.1 `classifyFailure` input gains an optional `retryAfterMs` field (additive, so nothing breaks), and `retryDelayMs` is a new export.
- No data-model or frontend contract change.
