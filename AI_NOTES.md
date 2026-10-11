# AI notes

Everything below is taken from the git history, `architecture/docs/DESIGN.md` (revision log and ADRs), `docs/ai-journal.md` (a log written at the moment each AI wrong turn happened) and `docs/verification/`. Where the record does not say, the line is marked **[ROHAN: confirm]** so it can be filled in or removed rather than guessed.

## Tools and models

- **Claude Code** (the CLI, on the Claude Agent SDK) was the only AI tool used to write code, tests and docs. Its commits carry `Co-Authored-By` lines: 5 early commits (the design import, workspace scaffold, shared enums, domain types, signature and retry classification) name Claude Opus 5.5, and the other 72 name Claude Sonnet 5.5. **[ROHAN: confirm which model played which role, e.g. architect vs implementers]**
- Work was split across project agents defined in `.claude/agents/`: `backend-implementer` (apps/api, packages/shared, scripts), `frontend-implementer` (apps/web, the Angular dashboard), and `quality-verifier` (read-only black-box checks, reports in `docs/verification/`). A main session picked each build-plan step from DESIGN section 16, delegated it, reviewed the diff and committed.
- Guard rails were code, not hopes: `.claude/hooks/` blocks writes of anything that looks like a secret and any read of the env file, limits where each agent may write, formats on edit, and re-runs typecheck, lint and tests when an agent stops. `.claude/skills/` hold the project's rules (contract-first, discord-interactions, resilience, security-secrets, and so on).
- Library and API facts were looked up in current docs (Context7, ai.google.dev, Discord's docs) rather than recalled; the journal records the times that mattered.
- No other AI tool is recorded in the repository. **[ROHAN: confirm none was used outside the repo, e.g. for the design phase or chat]**

## Decisions made by the human

Only decisions the record attributes to an explicit instruction are listed.

1. **Connecting a server is first-claim-wins, one managing admin per server (DESIGN rev 6, commit `d65f004`).** The record says this was done "at the human's explicit instruction" while building the connect flow. The design had left open who may claim a server; letting any admin claim any server would let one admin take over another's. The residual weakness is written down rather than hidden: connecting is not proof of Discord ownership, so anyone with a dashboard account who knows an unclaimed server's id can claim it. Discord OAuth2 with a `MANAGE_GUILD` check is the production fix (DESIGN ADR-0003 consequences, README Known limitations).
2. **Skip server-sent events; keep the polling live log (Step 6, item E).** The Step 6 instruction for this build said to skip SSE because many free hosts buffer streams, and to document polling as solid. DESIGN rev 8 and the README record it. **[ROHAN: confirm this was your call rather than the orchestrator's recommendation]**
3. **A follow-up that the webhook refuses with 401 or 404 is fatal and goes straight to the channel fallback, never retried (proposal 0001, DESIGN rev 2, section 11.4).** The architecture accepted the proposal with amendments; the reasoning (a retry repeats a deterministic failure and counts toward Discord's invalid-request ban) is in section 11.4. **[ROHAN: confirm you accepted this yourself]**

## The hardest bug or wrong turn: five candidates, none picked

Listed with the commit that fixed or guards it and how it was caught. Ranking them is left to the author.

1. **Saved rules were never read by the bot** (found in the Step 5 audit; fixed in `57cf16e`, tests in `cb84154`). Step 4 shipped rule editing with green tests, but the interaction path still used hard-coded defaults, so switching `/report` off in the dashboard changed nothing. Caught by grepping for callers of `evaluate` during the Step 5 audit, and independently by the quality-verifier's local run (finding F1; that report is not committed yet). Journal: "step 5 audit".
2. **The landing page never left "Finding your servers" in a real browser with 200 green unit tests** (fixed in `f50ad92`). Two components both asked a shared store to load; the second saw `loading`, returned early and gave up. The unit test never had the shell, so the two callers never raced. Caught by driving the production build in Chrome. Journal: "step 4 item 6 (web)".
3. **Three tests went red on their own when the wall clock passed a hard-coded "now"** (fixed in `a6f0f0d`). A fixed test clock was mixed with the database's real `now()` for `job.next_run_at`, so once real time passed the fixed date the worker saw the job as not due yet. They had failed since the Step 3 commit and a first agent had reported them without investigating. Caught when the full suite was run and a debug query showed a pending job with no attempts. Journal: "step 4 item 7".
4. **A calendar-invalid log cursor gave a 500** (fixed in `53d595b`). The cursor was checked by regex shape only, and Postgres rejected month 13 at query time. Caught by the quality-verifier sending a crafted cursor; the verifier is read-only, so the first suggested fix was applied separately. Journal: "backend: log cursor timestamp validated by regex only".
5. **Validation errors would have echoed attacker-chosen text** (fixed in `2e7ec77`). A helper described as "paths, never values" turned out to put an unknown key's name, which the caller typed, into the 400 body and the log. Caught while writing a sentinel test for an unknown key, from the test's own expectation, before it shipped. A related leak of a stored rule key name into a warning log was caught later by a test written for it (journal: "step 5: my own warning log leaked"). Journal: "step 4 item 3".

Also worth knowing, from the journal: the recommended `discord-interactions` `verifyKey` is asynchronous and would have been dropped into a synchronous boolean contract, which accepts every forged request if the Promise is not awaited. It was caught while reading the design, before any code, and replaced by `node:crypto` (`ec643cc`).

## What I would add with more time

- Discord OAuth2 sign-in with a `MANAGE_GUILD` check, replacing first-claim-wins server connection.
- A live run of the Gemini tagging path with a real key, and an unattended soak of the retry and fallback paths against the real Discord and Slack services. Only local stub servers were used for those.
- An idempotency design for the Slack mirror (the one at-most-once gap), for example posting through an API that accepts a client-supplied key.
- Server-sent events with a fallback to polling, once a host that streams unbuffered is chosen.
- A shared (database-backed) login throttle so it survives restarts and several instances, and a retention sweep of old done jobs.
- Fill the deferred reply before the mirror and tag steps, so a slow Slack or Gemini never leaves a user looking at "thinking...".
- A dedicated audit trail table for admin actions, instead of security events in the log stream.

## Prompt excerpt from the trickiest moment

**[ROHAN: add one short excerpt of your own prompt if you want one here; the repository does not record your prompts, so none is invented.]**
