# AI journal

Running log of moments where an AI agent's assumption or generated code turned out wrong, how it was noticed, and how it was fixed. Format and rules: `.claude/skills/ai-journal/SKILL.md`. Source material for `AI_NOTES.md`.

<!-- Newest entries at the bottom. -->

### 2026-10-11 — design/retry: AI-written design and skill disagree on which 4xx to retry
- **Believed / generated:** DESIGN §14 (AI-assisted) says Discord follow-up "401/404 → if < 15 min, retry"; the AI-written `resilience` skill lists 408/425 as retryable. CLAUDE.md and DESIGN §8.1 say every 4xx except 429 is fatal, and the §8.1 `classifyFailure({status?, kind?})` signature has no token-age input to express §14's rule.
- **Noticed by:** backend-implementer cross-reading §14 against §8.1 and CLAUDE.md before writing `classifyFailure`; no code was written for it.
- **Root cause:** the failure catalogue was written per integration while the classifier contract was written generically, and neither was checked against the other. Retrying a deterministic 401 would also count toward Discord's invalid-request (Cloudflare ban) limit.
- **Fix:** implementation stopped; `architecture/docs/proposals/0001-retry-classification-discord-followup-4xx.md` recommends keeping 4xx fatal, with immediate bot-token channel fallback for follow-up 401/404.
- **Cost:** caught before any code. Shipped as written, it would have burned 8 attempts per job on a dead token and risked an IP ban.
- **Lesson → guardrail:** proposal pending. Once accepted, a `classifyFailure` table test pins 401/404/408/425 → fatal.

### 2026-10-11 — design/signature: recommended library's API does not fit the contract it was recommended for
- **Believed / generated:** DESIGN §4 says to use `discord-interactions` `verifyKey`, while §8.1 specifies `verifySignature(...): boolean` (synchronous). `verifyKey` returns `Promise<boolean>`, so dropping it into a sync boolean contract invites the un-awaited-Promise-is-truthy bug that accepts every forged request.
- **Noticed by:** backend-implementer, comparing §4 with the §8.1 signature while writing `domain/signature.ts`.
- **Root cause:** library recommendation and interface written separately; the async nature of `verifyKey` (v4+) was not carried into the contract.
- **Fix:** `apps/api/src/domain/signature.ts` uses `node:crypto` `verify(null, …)` with an SPKI-wrapped raw key (the alternative §4 and CLAUDE.md already allow), so it is synchronous and has no dependency. Tests cover tampered body/timestamp, wrong key, missing headers, bad hex and an invalid curve point.
- **Cost:** none (caught before code). Had it been used un-awaited, forged requests would have been accepted, and Discord would have removed the endpoint.
- **Lesson → guardrail:** `signature.test.ts` asserts `false` for forged input, which an un-awaited Promise would fail.

### 2026-10-11 — design/modules: my proposal split the shared contract across domain and packages/shared without a dependency direction
- **Believed / generated:** proposal 0002 (backend-implementer, me) put the status enums in `domain/types.ts` and the rule schema in `packages/shared`. Rev 2 adopted it verbatim: "enum … in `domain/types.ts` (exported to `packages/shared`)" (§8.3) next to "rule schemas live in packages/shared", which `domain/rules.ts` must import, while §7 still says "`domain` imports nothing outside `domain`".
- **Noticed by:** the orchestrator's resume note asked how domain may depend on packages/shared. Re-reading rev 2 §7 line 337 against §8.3 lines 525/551/589 showed a violation of §7 and a shared↔api package cycle.
- **Root cause:** I placed each artefact where it "felt" right without drawing the import graph. The architect accepted it, and nobody checked §7 against the new §8.3.
- **Fix:** implementation stopped before `types.ts`/`rules.ts`. `architecture/docs/proposals/0003-domain-shared-dependency-direction.md` recommends making shared a pure leaf package that domain may import, enforced by lint.
- **Cost:** caught before code. Shipped as written, the frontend would build against a package that imports the backend, or the schemas would be duplicated and drift.
- **Lesson → guardrail:** when a proposal moves a type between packages, state the import direction explicitly. Once accepted, a lint rule on `packages/shared` will ban `apps/*`, `node:*` and I/O imports.

### 2026-10-11 — design/modules: my proposal 0003 wrote an allow-list that excludes my own signature.ts
- **Believed / generated:** proposal 0003 (backend-implementer, me) recommended "domain imports only domain, `@report-line/shared` and `zod`". Rev 3 adopted it verbatim in §7. But `domain/signature.ts`, which I wrote in round 1, imports `node:crypto`, the Ed25519 option CLAUDE.md and §4 allow.
- **Noticed by:** converting domain's lint rule to the rev 3 allow-list. Written to the letter, it would fail lint on `signature.ts`.
- **Root cause:** I wrote the allow-list from the new dependency (shared) and didn't diff it against the imports already in `domain/`. A one-line `grep "^import" src/domain/*.ts` would have caught it.
- **Fix:** domain keeps the existing deny-list (which allows shared, zod and node:crypto). `architecture/docs/proposals/0004-domain-allow-list-node-crypto.md` recommends naming `node:crypto` (for signature.ts only) in §7 and then switching to a strict allow-list.
- **Cost:** none in code. The doc contradicted itself for one revision, which cost one extra round with the architect.
- **Lesson → guardrail:** before proposing an import rule, grep the current imports of the folder it governs. Once 0004 is accepted, the rule becomes a strict allow-list lint.

### 2026-10-11 — docs/context: apps/api/CLAUDE.md names a file layout that DESIGN §7 does not have
- **Believed / generated:** the scaffolded `apps/api/CLAUDE.md` (AI-written) says "`src/app.ts` builds the app… `src/main.ts` only bootstraps" and "`src/config/env.ts` is the only reader of `process.env`". DESIGN §7 specifies `http/server.ts` (`createServer`), `index.ts` and `config.ts`. The `security-secrets` skill also says `config/env.ts`.
- **Noticed by:** backend-implementer, reading both before creating the Step 1 files; following the per-folder CLAUDE.md would have produced a tree that disagrees with the design and with §16's references.
- **Root cause:** context files and skills were drafted in parallel with the design and never cross-checked on file names.
- **Fix:** followed DESIGN §7 (the contract, per `contract-first`): `config.ts`, `http/server.ts`, `index.ts`. The stale names in `apps/api/CLAUDE.md` and the `security-secrets` skill are left for the architect (outside my write scope).
- **Cost:** none (caught before code). Left alone it would have made two agents place the same file in two places.
- **Lesson → guardrail:** none yet; the orchestrator should align `apps/api/CLAUDE.md` with DESIGN §7.

### 2026-10-11 — tooling/hooks: the Bash guard blocked a heredoc that merely mentioned the env file
- **Believed / generated:** I wrote `.env.example` with a shell heredoc whose first comment line said "Copy to .env". `guard-bash.mjs` refused the whole command ("Reading .env would copy secrets…") even though nothing was read.
- **Noticed by:** the hook error message; the file was not created and the following `git commit` in the same command did not run.
- **Root cause:** the guard matches the text `.env` anywhere in the command line, not only as a file argument. A false positive, but a safe one.
- **Fix:** wrote the file with the Write tool (which has its own `.env.example` allowance) and reworded the comment.
- **Cost:** one retry. No secret was at risk.
- **Lesson → guardrail:** create env templates with Write, not shell heredocs. Hook left unchanged (it is the architect's).

### 2026-10-12 — docs/context: the Step 2 brief cites a DESIGN section that is not in DESIGN.md
- **Believed / generated:** the task said to read "DESIGN.md rev 4 ... §9 (all, incl. 'Rev 4 data-model decisions')". I went looking for that section before writing the migration.
- **Noticed by:** `grep -i "rev 4"` over DESIGN.md found nothing; the header stops at "rev 3, 3.1", and the only uncommitted change to DESIGN.md is the §7 module-tree split of `reply.ts`.
- **Root cause:** the brief was written against a revision of the design that was never saved (or is in an unsaved editor buffer).
- **Fix:** built from the §9 ER diagram and enum list plus the decisions the brief itself spells out (nullable `guild.name`, `post_channel_id`, `mirror_webhook_enc`, guild upsert on first interaction). Those all appear in the committed §9 ER diagram, so no contract was invented. Reported to the orchestrator to confirm nothing else is in the missing section.
- **Cost:** a few minutes; risk was silently missing a decision, which is why the brief's list was cross-checked against the ER diagram.
- **Lesson → guardrail:** none; the architect should save rev 4 into DESIGN.md.

### 2026-10-12 — ledger: transaction must live on ONE checked-out client (decision, not a bug)
- **Believed / generated:** the easy shape is `pool.query('BEGIN')`, `pool.query(INSERT ...)`, `pool.query('COMMIT')`. Each call may use a different pooled connection, so BEGIN and COMMIT would land on different sessions and the "transaction" would be unrelated statements: a failed job insert would leave an orphan interaction row, which defeats the outbox.
- **Noticed by:** reading the `resilience` skill's request-path rule before writing `PgLedger`; the forced-failure test (`CHECK (false) NOT VALID` on `job`) is what proves it.
- **Root cause:** `pg.Pool#query` hides connection checkout; nothing in the types warns that it is not transactional.
- **Fix:** `PgLedger.recordAndEnqueue` uses `pool.connect()` once, runs BEGIN..COMMIT on that client, rolls back on any error, and releases in `finally` (`release(true)` destroys the connection if ROLLBACK itself failed).
- **Cost:** none (avoided).
- **Lesson → guardrail:** `pgLedger.test.ts` asserts no interaction, action or guild row survives a failed job insert, and that the pool is not starved after repeated failures.

### 2026-10-12 — testing: my first failure injection depended on a driver behaviour I had not verified
- **Believed / generated:** to make the job insert fail I first wrote `tokenExpiresAt: new Date(Number.NaN)`, assuming `pg` serialises an invalid Date to text Postgres rejects. It could also have become NULL, and `token_expires_at` is nullable, so the "failing" insert would have succeeded and the test would have passed vacuously on the success path.
- **Noticed by:** re-reading the test before any database existed to run it against, asking "what if this does not fail?".
- **Root cause:** reaching for a convenient bad input instead of a guaranteed failure.
- **Fix:** `forceJobInsertFailure()` adds `CHECK (false) NOT VALID` to `job` for the test, so every job insert fails with SQLSTATE 23514 after the interaction and action inserts succeeded; the test asserts the code.
- **Cost:** none.
- **Lesson → guardrail:** failure-path tests inject the failure in the database, not through a guess about input handling.

### 2026-10-12 — tooling: a stand-in Postgres desynced after a failed statement and looked like a ledger bug
- **Believed / generated:** with no Postgres available I ran the DB tests against PGlite through `pglite-socket` (a throwaway scratch install, not part of the repo). After the first forced failure, `SELECT count(*)` returned ZERO rows and the next insert reported `'duplicate'` with nothing committed.
- **Noticed by:** `count(*)` cannot return no rows in real Postgres, so the emulator's protocol state was suspect, not `PgLedger`. Replaying the exact statements through PGlite's direct API (no socket) gave the expected result: guild, interaction, action and job all 0 after ROLLBACK, and SQLSTATE 23514 on the job insert.
- **Root cause:** `pglite-socket` fronts a single-session engine; concurrent or post-error sockets share that session.
- **Fix:** none needed in code. The migration SQL, ledger SQL, the rollback behaviour and the status query were verified against PGlite directly. The concurrency tests (10 identical deliveries) CANNOT be validated that way and remain unrun until a real Postgres exists.
- **Cost:** about 15 minutes; the risk was "fixing" correct code to satisfy a broken emulator.
- **Lesson → guardrail:** the human supplies real Postgres (README "Database"); the 10-way concurrency tests are the first thing to run on it.

### 2026-10-12 — lint: `security/detect-object-injection` is noise in this codebase (decision)
- **Believed / generated:** enabling `eslint-plugin-security` recommended as-is.
- **Noticed by:** the rule flags every `obj[key]`, including typed lookups like `ACTION_SUMMARIES[action.type]` where `action.type` is a closed union; with `noUncheckedIndexedAccess` the compiler already constrains these.
- **Root cause:** the rule is a syntactic heuristic with no type information.
- **Fix:** disabled that one rule in `eslint.config.js` with the reason; the rest of the security rules stay on (non-literal fs paths and regexps, child_process, eval, unsafe regex).
- **Cost:** none.
- **Lesson → guardrail:** the rule's intent (no user-controlled keys into maps) is covered by the existing guidance to use `Map` and zod `.strict()`.

### 2026-10-12 — environment: I made Docker Compose the only documented database, and Docker cannot run here
- **Believed / generated:** my Step 2 README and `docker-compose.yml` presented Compose as the way to get Postgres, assuming Docker Desktop was usable ("Docker exists at the path, the daemon is just stopped").
- **Noticed by:** the human reported Docker cannot run on this machine and set up a standalone PostgreSQL 18 on port 5433 instead; their quick edit of the compose port mapping to `5433:5433` would also have broken the container (it listens on 5432 inside).
- **Root cause:** I treated "docker.exe is on PATH" as "Docker works" and never asked.
- **Fix:** README documents standalone `initdb`/`pg_ctl` (Windows) as Option A, Compose as Option B, hosted as C; compose maps `${POSTGRES_PORT:-5432}:5432`.
- **Cost:** none in code; the first run of the suite on real Postgres passed (294 API + 25 shared tests), including the concurrency tests PGlite could not exercise.
- **Lesson → guardrail:** ask what the host can run before writing setup instructions around it.

### 2026-10-12 — step 3: the design text I was told to follow did not exist
- **Believed / generated:** the brief cited "Rev 5 decisions for Step 3" in DESIGN §9; I read §9 and found only the Rev 4 block and two ER-diagram lines.
- **Noticed by:** grep for "rev 5", "payload", "heartbeat" across DESIGN.md.
- **Root cause:** the architect's edit was only partly on disk when committed as "design rev 5".
- **Fix:** built from the decisions restated in the brief and listed every assumption in proposal 0005 rather than guessing silently.
- **Cost:** none in code; one open question (fallback channel rule).
- **Lesson → guardrail:** check that a cited section exists before relying on it.

### 2026-10-12 — step 3: tests that could not fail
- **Believed / generated:** my first pipeline tests all passed on the first run, including 15 Slack scenarios.
- **Noticed by:** suspicion about first-run green; I mutated the runner five ways (skip the mirror marker check, keep the token, flip ephemeral, ignore expiry, never mark mirror failed) and watched which tests failed.
- **Root cause:** none found; all five mutants were killed. The mutation check is what made that evidence.
- **Fix:** none needed. One test (the HTTP path) did fail for a test bug: the guild had no webhook, so the mirror was `skipped`; I seeded the webhook.
- **Cost:** about 10 minutes.
- **Lesson → guardrail:** run a quick mutation pass on retry/idempotency code before trusting a green suite.

### 2026-10-12 — tooling: long shell heredocs fail in this environment
- **Believed / generated:** writing files and scripts via `cat <<'EOF'` in one big Bash call.
- **Noticed by:** "unexpected EOF while looking for matching `'`" on several calls of 150+ lines.
- **Root cause:** the Bash tool's handling of long quoted heredocs on Windows; short ones worked.
- **Fix:** use the Write and Edit tools for files, small node scripts for multi-point edits.
- **Cost:** a few retries.
- **Lesson → guardrail:** none beyond this note.

### 2026-10-12 — step 4 item 1 (auth): two small wrong assumptions caught by my own tests
- **Believed / generated:** (a) the login schema used `z.email()` while the service trimmed and lower-cased the email, so I assumed `"  ADMIN@Example.test "` would sign in; (b) the argon2 hash string would read `m=19456,t=2,p=1`.
- **Noticed by:** `authRoutes.test.ts › email differs only in case or spaces` got 400 instead of 200 (zod rejected the leading space before the service ran); `argon2PasswordHasher.test.ts` received `m=19456,p=1,t=2`.
- **Root cause:** (a) normalisation lived in one layer and validation in another, so they disagreed about what "the same email" means; (b) I wrote the PHC parameter order from memory instead of looking at the library output.
- **Fix:** the shared `LoginRequest` now trims and lower-cases before validating (the service still normalises as defence in depth); the test pins the real order.
- **Cost:** minutes. Without the test, an admin pasting their email with a trailing space would have seen "invalid".
- **Lesson → guardrail:** the two tests above; normalise at the boundary schema.

### 2026-10-12 — tooling: Postgres for the tests was down and the 5433 instance had to be found
- **Believed / generated:** DB tests would just run, as in earlier steps.
- **Noticed by:** `ECONNREFUSED 127.0.0.1:5433` from every `pg/*.test.ts`.
- **Root cause:** the standalone instance from the README (Option A) is not a service; it was stopped, and its data directory is `E:\pgdata-reportline`, not the README's example path.
- **Fix:** started it with `pg_ctl ... -p 5433` (the call blocks on the log handle in this tool, so the process was left running).
- **Cost:** a few minutes. Not a code problem.
- **Lesson → guardrail:** none; a "start the test database" npm script would help (follow-up).
