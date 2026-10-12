# AI journal

A log of every time an AI agent's assumption or code turned out to be wrong while building The Report Line: what happened, how it was caught, how it was fixed, and what now stops it happening again. Entries were written at the moment each problem was found, then rewritten here in plain language. Nothing has been removed, so every entry still lines up with the commit history. `AI_NOTES.md` is drawn from this file.

"Agent" means one of the Claude Code agents described in DESIGN §17: the **backend** or **frontend implementer**, the read-only **quality verifier**, or the **orchestrator** (main session).

## At a glance

| Theme | Entries | What the theme is about |
|---|---|---|
| **Design gaps caught before coding** | 1, 2, 3, 4, 5, 7, 13 | The design, the skills and the context files disagreed with each other. Agents stopped and raised a proposal instead of guessing. |
| **Security** | 20, 32, 33, 35, 36 | Places where secrets or attacker-controlled text could have leaked, or crafted input caused a 500. |
| **Correctness and data** | 8, 16, 21, 31, 34 | Bugs that would have produced wrong behaviour in production. |
| **Test quality** | 9, 14, 19 | Tests that could have passed without proving anything. |
| **Frontend** | 26, 27, 28, 29, 30 | Angular, browser and Node-version surprises. |
| **Environment and tooling** | 6, 10, 11, 12, 15, 17, 18, 22, 23, 24, 25, 37, 38 | Shell quoting on Windows, local database setup, lint and formatting slips. No product impact, but real time lost. |

**The five worth talking about**

| # | Short version |
|---|---|
| 34 | Rule editing shipped with green tests, but the bot never read the saved rules. |
| 2 | The recommended Discord library's check is async; used as written it would accept every forged request. |
| 29 | The landing page hung for ever in a real browser while 200 unit tests passed. |
| 1 | Retrying Discord 401s would have burned retries and risked an IP ban for the bot. |
| 20 | Validation errors would have echoed attacker-chosen text back in responses and logs. |

---

## Design gaps caught before coding

### 1. Two documents disagreed about which errors to retry
*2026-10-11 · backend implementer · design/retry*

- **What went wrong:** One part of the design said "if Discord's follow-up returns 401 or 404 within 15 minutes, retry". Another part, plus `CLAUDE.md`, said every 4xx except 429 is final. The resilience skill also listed 408 and 425 as retryable. The retry function's signature had no way to express the first rule anyway.
- **How it was caught:** The agent cross-read the sections before writing `classifyFailure`. No code had been written.
- **Why it happened:** The failure table and the retry contract were written separately and never checked against each other.
- **Fix:** Proposal 0001. 4xx stays final; a 401/404 on the follow-up goes straight to the channel fallback.
- **Impact if missed:** Eight pointless retries per job on a dead token, and repeated 401s count towards Discord's limit that temporarily bans the bot's IP.
- **Lesson:** A table test now pins 401, 404, 408 and 425 as final.

### 2. The recommended library would have accepted forged requests
*2026-10-11 · backend implementer · design/signature*

- **What went wrong:** The design recommended `verifyKey` from the `discord-interactions` package, but also defined `verifySignature(...)` as returning a plain `boolean`. `verifyKey` returns a Promise. A Promise that is not awaited is "truthy", so `if (verifyKey(...))` would pass for every request, forged or not.
- **How it was caught:** Comparing the two sections while writing `signature.ts`.
- **Why it happened:** The library choice and the interface were written separately; the library had become async in a newer version.
- **Fix:** Used Node's built-in `crypto.verify` instead: synchronous, no dependency (ADR-0007). Tests cover tampered body, tampered timestamp, wrong key, missing headers, bad hex and an invalid key.
- **Impact if missed:** Forged requests accepted, and Discord would have removed the endpoint after its own invalid-signature checks.
- **Lesson:** The signature tests assert `false` for forged input, which an un-awaited Promise would fail.

### 3. Shared types were split across two packages with no direction
*2026-10-11 · backend implementer · design/modules*

- **What went wrong:** The agent's own proposal put status enums in the backend's `domain` folder and rule schemas in `packages/shared`, and the design adopted it. That made the shared package depend on the backend while the backend depended on shared: a cycle.
- **How it was caught:** The orchestrator asked how `domain` was allowed to import `packages/shared`; re-reading showed the rule being broken.
- **Why it happened:** Each type was placed where it "felt right" without drawing the import graph.
- **Fix:** Proposal 0003. `packages/shared` became a leaf package that imports only `zod`; everything else imports it. Lint enforces it.
- **Impact if missed:** The Angular build would compile against backend code, or the schemas would be copied and drift apart.
- **Lesson:** When moving a type between packages, state the import direction explicitly.

### 4. A new import rule would have banned an existing file
*2026-10-11 · backend implementer · design/modules*

- **What went wrong:** The next proposal said `domain` may import only `domain`, shared and `zod`. But `signature.ts`, already written, imports `node:crypto`.
- **How it was caught:** Turning the rule into a lint config; it would have failed on `signature.ts`.
- **Why it happened:** The rule was written from the new dependency without checking existing imports.
- **Fix:** Proposal 0004: allow `node:crypto` in `signature.ts` only, then enforce a strict allow-list.
- **Impact if missed:** One extra round with the design; no code impact.
- **Lesson:** Before proposing an import rule, list the current imports of the folder it governs.

### 5. A folder's instructions named files the design did not have
*2026-10-11 · backend implementer · docs/context*

- **What went wrong:** `apps/api/CLAUDE.md` said to create `src/app.ts`, `src/main.ts` and `src/config/env.ts`. The design said `http/server.ts`, `index.ts` and `config.ts`.
- **How it was caught:** Reading both before creating the first files.
- **Why it happened:** Context files and skills were drafted in parallel with the design and not cross-checked.
- **Fix:** Followed the design, which is the contract. The stale names were reported.
- **Impact if missed:** Two agents could have put the same file in two places.
- **Lesson:** Context files need the same review as the design. (`apps/api/CLAUDE.md` still has the old names.)

### 7. A task cited a design section that did not exist
*2026-10-12 · backend implementer · docs/context*

- **What went wrong:** The Step 2 brief said to read "Rev 4 data-model decisions" in the design. The saved file had no such section.
- **How it was caught:** A search of the design for "rev 4" found nothing.
- **Why it happened:** The design edit had not been saved before the brief was written.
- **Fix:** Built from the ER diagram and the decisions spelled out in the brief, cross-checked so nothing was invented, and reported the gap.
- **Impact if missed:** A decision could have been silently skipped.
- **Lesson:** Check a cited section exists before relying on it.

### 13. It happened again in Step 3
*2026-10-12 · backend implementer · step 3*

- **What went wrong:** The Step 3 brief cited "Rev 5 decisions"; the design had only two diagram lines for them.
- **How it was caught:** Searching the design for "rev 5", "payload" and "heartbeat".
- **Why it happened:** The design edit was only partly saved when it was committed.
- **Fix:** Built from the brief and listed every assumption in proposal 0005 instead of guessing quietly.
- **Impact if missed:** None in code; one open question about the fallback channel.
- **Lesson:** Same as 7. Two occurrences made it a habit to check.

---

## Security

### 20. Validation errors would have echoed attacker-chosen text
*2026-10-12 · backend implementer · step 4, connect/settings/rules*

- **What went wrong:** Error responses list which fields were invalid, using a helper described as "field paths, never values". But for an unknown key, the "path" is the key name itself, which the caller typed. A key name can carry anything: a pasted secret or a log-injection string.
- **How it was caught:** Writing a test with a marker string in a key name. The agent's own expected output contained the marker, which gave it away.
- **Why it happened:** Assuming a "path" is always text the schema defines.
- **Fix:** `publicFieldPaths` only shows paths the API itself defines; anything else becomes the nearest known parent or `(root)`. Tests assert the marker never appears in a response or a log.
- **Impact if missed:** A small channel for reflecting attacker text into 400 responses and the security log.
- **Lesson:** Test with hostile input in key position, not just value position.

### 32. A crafted log cursor returned a 500
*2026-10-12 · quality verifier · backend*

- **What went wrong:** The dashboard's paging cursor contains a timestamp, checked only by a regex for its shape. Month 13 matched the regex, then Postgres rejected it, giving a 500.
- **How it was caught:** The verifier sent a cursor with the date `2026-13-45T25:61:61`.
- **Why it happened:** Checking that a value looks like a date is not checking that it is one.
- **Fix:** See 33. (The verifier is read-only, so it only reported.)
- **Impact if missed:** Any logged-in admin could trigger 500s and error-log noise. No data leak; queries stay scoped to the admin's servers.
- **Lesson:** Test impossible dates: month 13, 30 February, year 0.

### 33. The first fixes for the verifier's findings were incomplete
*2026-10-12 · backend implementer · backend*

- **What went wrong:** (a) Parsing the cursor with JavaScript's `Date` seemed enough, but `new Date('2026-02-30')` silently rolls over to March, and year 0 is valid in JavaScript but not in Postgres. (b) A guard meant to keep `/api/..` paths away from the static file server only covered the fallback route, while the static server ran first and decoded `%2e%2e` itself.
- **How it was caught:** Reasoning through the cases before running them, then switching the new guard off to confirm the new tests failed without it.
- **Why it happened:** Treating "JavaScript can parse it" as "Postgres will accept it", and assuming a check on one middleware covered the one before it.
- **Fix:** The date must round-trip exactly and have year ≥ 1; database date errors also map to "invalid cursor"; the path guard now wraps the static server too.
- **Impact if missed:** Two of three crafted dates would still have got through.
- **Lesson:** Prove a regression test works by disabling the fix and watching it fail.

### 35. A warning log leaked a key name from a corrupt rule
*2026-10-12 · backend implementer · step 5*

- **What went wrong:** When a stored rule is invalid, the bot logs which fields are wrong. It reused the editor's helper, which names unknown keys on purpose, because in the editor the admin typed them. In a stored row, that key name is untrusted data.
- **How it was caught:** A test that corrupted a rule with a real `UPDATE`, using a marker string as the key name. The marker appeared in the log.
- **Why it happened:** Reusing a function in a place where its safety assumption no longer held.
- **Fix:** `loggableFields` reports only known rule fields; anything else is `(root)`.
- **Impact if missed:** Arbitrary stored text written into logs.
- **Lesson:** "Paths, not values" is not enough when the path itself is data.

### 36. Remembered Gemini API details were out of date
*2026-10-12 · backend implementer · step 6*

- **What went wrong:** The agent remembered the old Gemini style of passing the API key in the URL (`?key=…`) and expected the docs to centre on `generateContent`.
- **How it was caught:** The current docs page described a newer API; the library docs showed the key in an `x-goog-api-key` header.
- **Why it happened:** Memory of an older docs layout; two official pages also disagreed.
- **Fix:** Kept `generateContent` (still documented) with the key in the header only, behind the `Tagger` interface so a later switch is one file.
- **Impact if missed:** The API key would have appeared in URLs and any proxy logs.
- **Lesson:** A test asserts the key is in the header and in no URL, log line, response or attempt record.

---

## Correctness and data

### 8. A database transaction must use one connection
*2026-10-12 · backend implementer · ledger (decision, not a bug)*

- **What went wrong:** The easy way to write a transaction with `pg` is `pool.query('BEGIN')`, then the inserts, then `pool.query('COMMIT')`. Each call can use a different connection from the pool, so it would not be a transaction at all.
- **How it was caught:** Reading the resilience skill's rule before writing the ledger.
- **Why it happened:** `pool.query` hides which connection it uses.
- **Fix:** Check out one client, run BEGIN to COMMIT on it, roll back on error, always release it.
- **Impact if missed:** A failed job insert could leave an orphan interaction row, which breaks the outbox guarantee.
- **Lesson:** A test forces the job insert to fail and asserts nothing else survives.

### 16. Two small assumptions in sign-in
*2026-10-12 · backend implementer · step 4, auth*

- **What went wrong:** (a) The service trimmed and lower-cased the email, so `"  ADMIN@Example.test "` should have signed in, but the request schema rejected the leading space before the service ran. (b) The argon2 hash parameters were written from memory in the wrong order.
- **How it was caught:** The agent's own tests failed.
- **Why it happened:** Normalisation and validation lived in different layers; (b) was memory instead of checking the output.
- **Fix:** The shared schema trims and lower-cases before validating; the test pins the real format.
- **Impact if missed:** An admin pasting their email with a trailing space would see "invalid".
- **Lesson:** Normalise input at the boundary schema.

### 21. The "first claim wins" rule needed a different key
*2026-10-12 · backend implementer · step 4, connect*

- **What went wrong:** (a) The plan was to enforce "one admin per server" with the existing `(admin_id, guild_id)` key. That key only conflicts on the same pair, so admin B could claim admin A's server. (b) Running Prettier on whole folders reformatted three unrelated files.
- **How it was caught:** (a) Reasoning before running; (b) `git status`.
- **Why it happened:** (a) The earlier schema allowed many admins per server. (b) Prettier formats every file under a path.
- **Fix:** Migration 003 makes `guild_id` alone the key, so the database picks one winner. The unrelated files were restored. Removing the safety condition made four tests fail, as it should.
- **Impact if missed:** One admin could take over another's server.
- **Lesson:** Enforce ownership rules with a constraint, not with "check, then insert".

### 31. Tests broke by themselves when real time passed a fixed date
*2026-10-11 · backend implementer · step 4*

- **What went wrong:** Tests used a fixed fake "now" of 15:30 UTC that day, but the database sets `next_run_at` with its real clock. Once real time passed 15:30, the worker (on the fake clock) saw new jobs as not yet due.
- **How it was caught:** A full test run showed three failures that also failed at the earlier commit. A debug query showed a pending job with no attempts.
- **Why it happened:** Mixing a fake clock in code with the real clock in the database.
- **Fix:** A helper pins `next_run_at` to the test clock before draining.
- **Impact if missed:** The first agent to see the failures reported them without investigating; they would have kept failing.
- **Lesson:** If code uses a fake clock, the database side needs it too.

### 34. Saved rules were never read by the bot
*2026-10-12 · orchestrator audit, confirmed by the quality verifier · step 5*

- **What went wrong:** Step 4 delivered rule editing: strict validation, saved to the database, green tests. But the code handling commands still used built-in defaults. A comment even said "No rule store yet". Turning `/report` off in the dashboard changed nothing.
- **How it was caught:** During the Step 5 audit, searching for every caller of `evaluate` found one, with defaults hard-coded. The verifier found it independently.
- **Why it happened:** Editing and using the rules had separate acceptance criteria. Tests proved a row was written; nothing proved a row was read.
- **Fix:** `resolveAction` is now the single path from a stored rule to the bot's behaviour, used by commands, the form submit and the buttons. Tests change the row with SQL and watch the next command change.
- **Impact if missed:** A headline feature that looked finished and did nothing.
- **Lesson:** For every "configurable X", one test must change X and observe the behaviour, not only the stored row.

---

## Test quality

### 9. A failure test that might not have failed
*2026-10-12 · backend implementer · testing*

- **What went wrong:** To force a job insert to fail, the agent passed an invalid date, assuming Postgres would reject it. It could equally have become NULL, which the column allows, so the "failure" test might have passed on the success path.
- **How it was caught:** Re-reading the test and asking "what if this doesn't fail?".
- **Why it happened:** Using convenient bad input instead of a guaranteed failure.
- **Fix:** The test adds a `CHECK (false)` constraint to the table, so every insert fails with a known error code.
- **Lesson:** Inject failures in the database, not through a guess about input handling.

### 14. Checking that green tests can go red
*2026-10-12 · backend implementer · step 3*

- **What went wrong:** All the new worker tests passed first time, which is suspicious.
- **How it was caught:** The agent broke the code five ways on purpose (skip the Slack marker, keep the token, flip private/public, ignore expiry, never mark the mirror failed) and checked that tests failed.
- **Result:** All five were caught. One unrelated test had a setup bug (no webhook configured) and was fixed.
- **Lesson:** Do a quick mutation pass on retry and deduplication code before trusting a green suite.

### 19. A deliberately broken query broke for the wrong reason
*2026-10-12 · backend implementer · step 4, tenant isolation*

- **What went wrong:** To prove the SQL-level tenant check was tested, the agent removed it. Fourteen tests failed, but with a SQL syntax error (an unused parameter), not because data leaked. That proved nothing.
- **How it was caught:** Reading why the tests failed.
- **Fix:** Disabled the check in a way that keeps the SQL valid. Exactly two adapter tests failed, while the HTTP tests stayed green because the route guard still protected them.
- **Lesson:** Check why a broken version fails before counting it as caught. This also showed why the adapter-level test exists.

---

## Frontend

### 26. `Date.parse('-5')` returns a date
*2026-10-12 · frontend implementer · step 4, web*

- **What went wrong:** The code reading the `Retry-After` header tried `Date.parse` for anything that was not plain digits. `Date.parse('-5')` returns the year -5, not "invalid", so `Retry-After: -5` became "wait 0 seconds".
- **How it was caught:** The agent's own table test.
- **Fix:** Only strings containing a day or month name are tried as dates.
- **Impact if missed:** A bogus header would have invited immediate retries against a rate limiter.

### 27. Node 26's own `localStorage` hid the test environment's
*2026-10-12 · frontend implementer · step 4, web*

- **What went wrong:** A test checking "nothing was stored in localStorage" crashed: newer Node versions define their own `localStorage`, unusable without a flag, which overrides the browser simulation's.
- **How it was caught:** A TypeError plus a Node warning.
- **Fix:** The test installs recording stand-ins and asserts nothing was read or written. That is stronger than before: it also catches reads.

### 28. Fake timers froze Angular's renderer
*2026-10-12 · frontend implementer · step 4, web*

- **What went wrong:** (a) Tests faked timers to drive the 5-second poll, but zoneless Angular schedules rendering with a timer too, so the test waited for ever for a render on a clock that never moved. (b) A flag set inside a callback looked constant to TypeScript, and lint flagged it.
- **How it was caught:** Five tests timing out at exactly 5000 ms; a lint error.
- **Fix:** A separate test helper for fake-timer tests that advances the clock by zero and renders; the "changed" flag is now derived instead of mutated.

### 29. The first screen hung in a real browser while 200 tests passed
*2026-10-12 · frontend implementer · step 4, web*

- **What went wrong:** After sign-in, the landing page waited for the server list and then navigated. But the app shell also starts loading the list. When the landing page asked, the store was already "loading", so its call returned at once, it saw "not loaded", and gave up. The page showed a loading skeleton for ever.
- **How it was caught:** Running the production build in Chrome against a fake API.
- **Why it happened:** The unit test had no shell, so the two callers never raced.
- **Fix:** The landing page reacts to the store's state instead of awaiting its own call. A regression test starts the shell's load first.
- **Impact if missed:** The first screen anyone saw after signing in would have been broken.
- **Lesson:** A component that depends on shared state reacts to the store, not to its own call. Run the real build in a real browser before saying a screen works.

### 30. The agent's own test server broke, and a CSP blocked a layout check
*2026-10-12 · frontend implementer · step 4, web*

- **What went wrong:** A throwaway file server compared Windows paths with backslashes against a forward-slash root, so it served `index.html` for every script. Then a 320 px layout check inside an iframe failed because the app's own security policy forbids being framed.
- **Fix:** Fixed the path handling. The 320 px check stayed unverified in a browser and was reported as such.
- **Lesson:** The iframe failure was the security header doing its job.

---

## Environment and tooling

### 6. The command guard blocked a harmless command
*2026-10-11 · backend implementer · hooks*
The agent wrote `.env.example` through a shell command whose comment said "Copy to .env". The guard hook blocks any command mentioning `.env` and refused it. A safe false positive. **Fix:** create env templates with the file-writing tool.

### 10. A stand-in database looked like a ledger bug
*2026-10-12 · backend implementer · tooling*
With no Postgres available, tests ran against PGlite (an in-process Postgres) over a socket. After one failed statement, `SELECT count(*)` returned no rows, which real Postgres never does. The emulator, not the code, was wrong. **Fix:** verified the SQL against PGlite directly and left the concurrency tests for real Postgres. **Lesson:** don't "fix" correct code to satisfy a broken emulator.

### 11. A security lint rule was mostly noise
*2026-10-12 · backend implementer · lint (decision)*
`security/detect-object-injection` flags every `obj[key]`, including type-safe lookups. **Fix:** disabled that one rule with a written reason; the other security rules stay on.

### 12. Docker was documented as the only database option, and Docker could not run
*2026-10-12 · backend implementer · environment*
The agent saw `docker.exe` on the path and assumed Docker worked. Rohan reported it could not run on this machine and set up standalone PostgreSQL. **Fix:** the README documents standalone, Docker and hosted options. **Lesson:** ask what the machine can run before writing setup instructions.

### 15. Long shell heredocs failed on Windows
*2026-10-12 · backend implementer · tooling*
Writing files with long `cat <<'EOF'` commands failed with quote errors. **Fix:** files go through the Write and Edit tools.

### 17. The test database was stopped
*2026-10-12 · backend implementer · tooling*
Every database test failed with "connection refused": the standalone Postgres is not a service and had stopped. **Fix:** started it. A "start the test database" script would help.

### 18. A number too big for JavaScript, and an edit that deleted half a file
*2026-10-12 · backend implementer · step 4*
(a) Test ids built as `900000000000000500 + n` collided, because numbers above 2^53 lose precision. That is the exact reason Discord ids are strings in this design. **Fix:** `BigInt`. (b) A regex replace "to end of file" deleted three exports. **Fix:** restored from git. **Lesson:** never do arithmetic on id-shaped numbers in JavaScript; anchor both ends of an edit.

### 22. Backticks inside a double-quoted command were executed
*2026-10-12 · backend implementer · tooling*
In bash, backticks inside double quotes run as commands, which blanked part of a code comment. **Fix:** restored by hand; edits go through files, not inline shell strings.

### 23. zod 4 treats `z.unknown()` keys as required, and the backtick mistake again
*2026-10-12 · backend implementer · step 4*
In zod 4, a missing `z.unknown()` key fails validation; it needed `.optional()`. The same backtick problem as entry 22 hit a test file. **Fix:** `.optional()`; test files written with the editor tools only.

### 24. A startup check written synchronously, and a `git checkout` that discarded work
*2026-10-12 · backend implementer · step 4*
(a) A synchronous file check inside server wiring broke the lint rule against sync I/O. **Fix:** an async check at startup. (b) `git checkout README.md` to undo formatting also undid the agent's own unsaved edit. **Lesson:** check `git diff` before checking out a file.

### 25. An apostrophe in a heredoc swallowed five files
*2026-10-12 · frontend implementer · tooling*
Text like "We can't reach the server" inside a multi-file shell command broke parsing, so none of the five files were written. **Fix:** every source file goes through the Write tool.

### 37. A bulk find-and-replace changed the wrong fixtures
*2026-10-12 · backend implementer · step 6*
A repo-wide `sed` added a new field to every matching test fixture, including ones typed against an internal interface that does not have it. The compiler caught it. **Fix:** reverted those. **Lesson:** run typecheck in every workspace after a shared-schema change.

### 38. Shell escapes corrupted a script, and an old README section too
*2026-10-12 · backend implementer · step 6*
Writing `seed-admin.ts` through the shell turned `\n`, `\r` and `\u0003` into real control characters. Checking the README the same way found Windows paths that had been corrupted the same way since Step 3. **Fix:** rewrote both with the Write tool. **Lesson:** any file containing backslashes is written without a shell in between, then inspected before commit.
