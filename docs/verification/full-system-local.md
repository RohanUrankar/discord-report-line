# Quality-bar report: full system (interactions, worker, dashboard), local, 2026-10-12, commit 53bb1f6

Tester: Claude Code (scripted black-box run over real HTTP; no application code changed, nothing committed). About 230 checks in four suites. No secrets, session ids, CSRF tokens or webhook URLs appear in this report.

## Setup

- Isolated API instance on port 3100: `npm run start -w @report-line/api` against the throwaway test database (`DATABASE_URL_TEST`, migrated, two seeded admins), a freshly generated Ed25519 keypair as `DISCORD_PUBLIC_KEY`, `SESSION_COOKIE_SECURE=false` (plain http), short backoff (`BACKOFF_BASE_MS=300`, `BACKOFF_MAX_MS=3000`).
- Downstreams: two recording stub servers written for the run, standing in for Slack (`SLACK_WEBHOOK_URL_PREFIX`) and Discord REST (`DISCORD_API_BASE_URL`). They keep request bodies and can script per-request responses (status, headers, delay) or be stopped entirely (connection refused). No traffic went to real Discord or Slack. The developer instance on port 3000 was not touched.
- Guild webhooks were set with `scripts/set-mirror-webhook.ts` (stdin), admins with `scripts/seed-admin.ts`.
- Not covered: the live Discord handshake, real slash commands in a test server, cold starts, `register-commands`, the deployed URL. Those need a manual pass (see "Still to do").

## Summary

| Suite | Area                                                                     | Checks      | Result                          |
| ----- | ------------------------------------------------------------------------ | ----------- | ------------------------------- |
| 1     | Signatures, PING, happy paths, input edge cases, duplicates, multi-guild | 65          | 65 pass                         |
| 2     | Slack and Discord failure paths, retries, fallback                       | 45          | 45 pass                         |
| 3     | Dashboard auth, CSRF, tenancy, config, static serving                    | 111         | 103 pass, 8 fail (see findings) |
| 4     | Crash recovery, pending-job drain, standalone worker                     | 11          | 11 pass                         |
| -     | Repo test suites (`npm test`)                                            | 1,072 tests | all pass                        |

## Suite 1: protocol and core loop

| Scenario                                                                               | Observed                                                                                                            | Result                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bad hex, short, empty signature; tampered body; tampered timestamp                     | 401, empty body                                                                                                     | PASS                                          |
| Validly signed, timestamp 10 min old or 10 min ahead                                   | 401                                                                                                                 | PASS                                          |
| Empty body, wrong content type, no headers, GET                                        | 401 / 401 / 401 / 404                                                                                               | PASS                                          |
| Signed non-JSON, JSON array, non-snowflake id                                          | 400, never 500                                                                                                      | PASS                                          |
| 2 MB body                                                                              | 413                                                                                                                 | PASS                                          |
| Rejected requests leave rows behind                                                    | none                                                                                                                | PASS                                          |
| PING                                                                                   | `{"type":1}`, `application/json`, never stored                                                                      | PASS                                          |
| `/status`                                                                              | type 4, 43 ms, recorded as answered, no job                                                                         | PASS                                          |
| `/report text:`                                                                        | type 5 in 6 ms; job done; token cleared; 1 Slack post; 1 PATCH of `@original`; attempts recorded (mirror, followup) | PASS                                          |
| Two guilds with different webhooks                                                     | each report reaches only its own webhook                                                                            | PASS                                          |
| Guild with no webhook                                                                  | job done, `mirror_status=skipped`, reply still filled                                                               | PASS                                          |
| `/status` counts                                                                       | per guild (G1 and G2 each 1 after one report each)                                                                  | PASS                                          |
| Missing, empty, whitespace, non-string, 1001-char text                                 | polite ephemeral reply (type 4, flag 64), no job                                                                    | PASS                                          |
| Exactly 1000 chars, unicode and emoji, markdown and code fence                         | accepted and deferred                                                                                               | PASS                                          |
| `@everyone`, `@here`, role and user mentions in report text                            | Discord reply `allowed_mentions: {parse: []}`; Slack text escaped                                                   | PASS                                          |
| Unknown command, DM (no guild), button click, modal submit, autocomplete, unknown type | 200 with polite message, no 500                                                                                     | PASS (button and modal are unhandled; see F1) |
| 10 concurrent identical interactions                                                   | 10 x type 5; 1 interaction row, 1 job, 1 action, 1 Slack post, 1 PATCH                                              | PASS                                          |
| 3 sequential replays; 5 concurrent duplicate `/status`; same id with a different token | still one row and one job; no extra posts                                                                           | PASS                                          |
| 30 distinct reports across 3 guilds at once                                            | all deferred (max 42 ms); 30 jobs done; 20 Slack posts (two guilds have webhooks), 30 PATCHes                       | PASS                                          |
| Finished jobs keep a token; webhook stored as plaintext                                | none; stored as encrypted bytea                                                                                     | PASS                                          |

## Suite 2: downstream failures

| Scenario                                 | Observed                                                                                                                                                  | Result |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Slack 503, 503, 200                      | attempts `retryable, retryable, success`; 1 reply                                                                                                         | PASS   |
| Slack 429 `Retry-After: 3`               | second call 3,075 ms later                                                                                                                                | PASS   |
| Slack 400 / 403 / 404 / 408 / 410        | one request, job dead, `mirror_status=failed`; user reply still edited, with a note that the notification failed                                          | PASS   |
| Slack 500 forever                        | 8 attempts with growing, jittered gaps (313, 621, 927, 657, 621, 2452, 1250 ms), job dead, readable `last_error` with no URL or token, token cleared      | PASS   |
| Slack hangs past the timeout, then ok    | timeout recorded as retryable; second attempt succeeds                                                                                                    | PASS   |
| Discord PATCH 503, 503, 200              | 3 PATCHes; exactly 1 Slack post (mirror marker honoured)                                                                                                  | PASS   |
| Discord PATCH 429 `Retry-After: 3`       | retry 3,086 ms later                                                                                                                                      | PASS   |
| Discord PATCH 404                        | one PATCH, no retry; one channel fallback post to the configured channel; fallback text excludes the ephemeral report text; interaction `fallback_posted` | PASS   |
| Discord PATCH 401                        | same as 404                                                                                                                                               | PASS   |
| Token expiry reached while Slack retries | no PATCH; one channel fallback                                                                                                                            | PASS   |
| Fallback post itself 403                 | job dead with "bot cannot post in that channel"                                                                                                           | PASS   |
| No `post_channel_id` configured          | fallback goes to the channel the command ran in                                                                                                           | PASS   |
| Discord fully down, then back            | job stays pending and retries; after recovery done, 1 Slack post                                                                                          | PASS   |
| Slack fully down, then back              | job retries; after recovery done, 1 Slack post, 1 PATCH                                                                                                   | PASS   |

## Suite 3: dashboard

PASS: anonymous requests 401; wrong password and unknown email give the same 401 body apart from `requestId`; malformed email, missing password, 5,000-char password, extra keys and object-injection bodies all 400; cookie is `HttpOnly; SameSite=Lax; Path=/` with no session id in the body; CSRF missing, wrong or from another admin 403; connecting an unknown server 404, malformed id 400, own server idempotent, another admin's server 404; every guild-scoped route (interactions, detail, settings, rules, PUTs) returns 404 with no data for a foreign guild, the same as for a nonexistent one; cross-guild interaction ids 404; list paging with cursor has no overlap, bad limit and cursor values 400; detail has the attempt history and no token or webhook data; 10 SSRF-style and malformed webhook URLs (wrong host, http, userinfo, metadata IP, `file:`, CRLF, 3,000 chars) all 400; a valid webhook is accepted, never echoed back (`mirrorConfigured` only) and the next report goes to the new URL; rule payloads with unknown command, extra key, version 2, wrong schema or a 5,000-char message get 400; logout invalidates the session server-side; login throttled from the third failed attempt (429); SPA and deep-link fallback served; unknown `/api` path 404 JSON; security headers present; no CORS header; path traversal 404; no secret-looking strings in the JS bundle.

FAIL / notes: see F1 to F4.

## Suite 4: crash recovery

| Scenario                                                          | Observed                                                                                                                        | Result        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| API killed while a Slack call (3 s) was in flight, then restarted | job row survived in `processing`; after lease expiry it was reclaimed and finished (attempt 2); 1 PATCH; 2 Slack posts in total | PASS (see N2) |
| Pending job inserted while no worker was running, API started     | drained to done                                                                                                                 | PASS          |
| `WORKER_MODE=standalone` with the API stopped                     | job processed; no HTTP listener opened                                                                                          | PASS          |

## Findings (most severe first)

**F1. Saved rules do not affect behaviour.** `PUT /api/guilds/:id/rules/:command` returns 200 and the dashboard shows the rule as customised, but the interaction path still evaluates with defaults (`interactions.ts`: "No rule store yet: every command is enabled with its default config"). Observed: `ephemeral:false` still deferred with flag 64; a custom `replyMessage` was ignored; `mirror:false` still posted to Slack (`mirror_status=sent`); `enabled:false` on `report` and on `status` still ran the command. Five failed checks. This is DESIGN Step 5 (rules-as-data, `RuleEngine`) and is expected to be missing, but the editor is live in the dashboard, so an admin or reviewer can change a rule and see nothing happen. Owner: backend (Step 5), or hide the rules editor until then.

**F2. Modal and buttons are unhandled (Step 5).** Component and modal-submit interactions answer "I don't know that command." (`interaction.unhandled_kind`). `/report` with no text returns the "needs some text" error instead of opening the modal that DESIGN §5.2 and Step 5 specify. Owner: backend (Step 5).

**F3. Rule `replyMessage` accepts `@everyone`.** Harmless today because every reply is sent with `allowed_mentions: {parse: []}` (verified), but once F1 is fixed the stored text reaches Discord, so keep that guard on the rule path. Owner: backend (check when wiring F1).

**F4. Test assumption, not a defect.** `PUT /settings {postChannelId: ""}` returns 200 and clears the channel. Fine if intentional (the fallback then uses the channel the command ran in); confirm the dashboard communicates it.

## Notes (design behaviour worth knowing)

- N1. The deferred reply is edited only after the mirror step finishes or gives up. With Slack down the user sees "thinking..." for the whole retry period, which with the default 60 s backoff cap can be minutes (up to the 15-minute token life). Consider filling the reply first and mirroring afterwards, or saying so in the demo.
- N2. A process killed during an in-flight Slack call produced 2 Slack posts. That is the at-least-once window between a successful call and the marker write; the deferred reply was still edited once.
- N3. The test instance ran without the `Secure` cookie flag (plain http). The default configuration was verified separately in the Step 4 report; recheck on the deployed URL.
- N4. The login rate limit engaged on the third failed attempt here (codes `401, 401, 429, ...`), tighter than the five-attempt window recorded in the Step 4 report. Confirm which value is intended; the earlier suite-3 login attempts from the same IP may have contributed.

## Still to do (needs the real services)

1. Save the endpoint URL in the Developer Portal (real PING and bad-signature handling).
2. `/status` and `/report text:` in the test server; check reply, Slack post, dashboard timeline without reload.
3. Re-run `attack.mjs --url https://<host>/interactions` (unsigned checks) against the deployed URL.
4. After 20+ minutes idle, one command still answers within 3 s.
5. Deployed cookie has `Secure`; `grep` the built bundle and repo for token patterns.
6. Re-run this suite after Step 5 lands, with the F1 checks as acceptance tests.

## Reproduction

The four suite scripts and the stub servers lived in the session scratchpad and are not in the repo. Say the word and they can be added under `scripts/` or `docs/verification/` so the run can be repeated.
