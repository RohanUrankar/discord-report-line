# 0005 — DESIGN.md has no "Rev 5 decisions for Step 3" section; record what Step 3 assumed

**Status:** Proposed
**Raised by:** backend-implementer, Step 3
**Blocks:** nothing. Step 3 is built; this asks the architect to confirm or correct the assumptions below.

## Context

The Step 3 brief says to follow DESIGN.md "§9 (incl. 'Rev 4' and 'Rev 5 decisions for Step 3')". The committed DESIGN.md (`docs: design rev 5`, 3d6f9ac) only adds `payload jsonb` and the `WORKER_HEARTBEAT` table to the §9 ER diagram (lines ~679-684). There is no "Rev 5" header line and no "Rev 5 decisions" paragraph; §9 ends its decisions at "Rev 4" (line 724-730), and line 728 still says "The worker heartbeat stays `null` until Step 3 decides where it is stored."

## Proposal

Add a "Rev 5 decisions" block to §9 stating what was built, or correct it:

1. `job.payload` is the rule snapshot plus the report (`text, userId, channelId, ephemeral, replyMessage, mirror, tag`); no credential. Migration 002 also creates `worker_heartbeat(id, beat_at)`; one row, id `worker`.
2. `token_expires_at = receivedAt + 14m30s`; the worker treats `<= now` as expired.
3. The worker has its own `pg.Pool` (max 3, statement timeout 10 s).
4. Fallback channel = `guild.post_channel_id`, else the channel the command ran in. This differs from §11.3 step 4, which makes a missing `post_channel_id` fatal. I chose the invoking channel because the connect flow (Step 4) does not exist yet and the fallback would otherwise always be dead.
5. A retryable Slack failure on the last allowed pass marks the mirror `failed` and the pass continues to the reply (the user still gets an answer); the job ends dead. Exhausted retries on the reply or the fallback end the job dead and the interaction `failed`, as in §11.3.
6. A job claimed more than `MAX_ATTEMPTS` times (workers kept dying) is ended dead.
7. Commits are guarded by the lease (`claimed_at`); a worker that lost its lease writes nothing.
8. One `job_attempt` row per outbound call (not per pass); a skipped mirror (no webhook) writes none.
9. A recording slower than `RECORD_TIMEOUT_MS` that still commits: the user saw `notRecorded` (ephemeral); the worker edits that message with the result.
10. The webhook ciphertext layout is `version | iv | tag | data` with the guild id as AES-GCM associated data.

## Options considered

A (recommended): merge the list above into §9. B: reject items 4 or 5 and tell me the intended behaviour; both are small changes in `reportJobRunner.ts`.

## Consequences

No interface in §8 changed. Item 4 is the only departure from existing text.
