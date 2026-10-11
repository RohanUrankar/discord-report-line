---
name: backend-guidelines
description: Coding conventions for the Node + Express + TypeScript backend in apps/api — applying DESIGN.md §7's hexagonal layout (domain / app / ports / adapters / http), dependency rules, thin handlers, TypeScript strictness (no any, branded ids, discriminated unions, exhaustive switches, as-const sets instead of enums), design-principle trade-offs (SRP/DIP without over-abstraction), request validation with zod, Postgres migrations and constraints, configuration, lint/tsconfig enforcement, testing with Vitest + Supertest, and code style. Use this whenever you create or modify anything under apps/api, packages/shared or scripts, add an endpoint, command, migration, adapter, port, error type or test, review backend code, or are unsure where backend code should live or how it should be written.
---

# Backend guidelines (apps/api)

Graders weigh "code quality and clarity — structure, readability, sensible choices". A small, predictable structure beats a clever one. `architecture/docs/DESIGN.md` §7–§9 define the structure, interfaces and data model — they win; this skill covers how to write the code inside that structure.

Detailed references (read when the task touches them):
- `references/typescript-style.md` — the full style rulebook with ✓/✗ examples (types, functions, control flow, classes, modules, errors, prohibited patterns).
- `references/enforcement.md` — `tsconfig`, ESLint and Prettier settings that turn these rules into failing builds, so they don't depend on anyone remembering them.

## Stack baseline

Node LTS, TypeScript `strict: true`, ESM, Express (5 unless the installed version says otherwise), zod, pino, Vitest + Supertest, `pg`/query builder per what the design and package.json say. Check current APIs via Context7 before using version-specific features (Express 5 path syntax and async error handling differ from Express 4).

## Layout (DESIGN.md §7, rooted at apps/api/src)

```
domain/     pure logic, no I/O — signature, router (classify), reply builder, rules engine, retry classification/backoff, types
app/        orchestration via ports — interactions handler, ledger (dedupe + outbox txn), worker, dashboard, auth
ports/      interfaces — repositories, DiscordClient, SlackMirror, Tagger, clock, random
adapters/   implementations — pg/*, discordHttp, slackHttp, geminiHttp
http/       Express wiring (server.ts: raw body on /interactions only) + middleware (raw body capture, logger, error handler)
config.ts   env parsing + validation, fail fast; the only reader of process.env
index.ts    starts HTTP server + in-process worker (WORKER_MODE=standalone runs worker only)
```

Tests sit next to the code (`*.test.ts`); shared helpers (signed-request builder, DB reset, stub servers) in `apps/api/test/helpers/`.

**Dependency rule:** `domain` imports nothing outside `domain`. `app` imports `domain` + `ports`. `adapters` implement `ports`. `http` wires everything. Nothing in `domain`/`app` imports Express, `pg` or `fetch`. If you feel the need to break this, that's a proposal (see `contract-first`), not a shortcut. Enforce it with a lint rule (see `references/enforcement.md`) — a rule that only lives in prose erodes within a few commits, especially when several agents are writing code.

Practical consequences:
- `http/server.ts` exports a `createServer(deps)` that doesn't listen, so Supertest can drive it with fake adapters.
- `clock` and `random` are injected — backoff jitter, token expiry and replay-window tests become deterministic.
- New command = route entry in `domain/router.ts` + reply/rule logic in `domain` + orchestration in `app/interactions.ts`. The decision table in DESIGN §5.4 is the spec.

## What each layer may do

| Layer | Does | Must not |
|---|---|---|
| `http/` handlers | Parse + validate input, call one `app` function, map the result to a response | Business rules, SQL, `fetch`, multi-step orchestration |
| `http/` middleware | Cross-cutting: raw body, request id, auth, CSRF, rate limit, the one error handler | Domain decisions |
| `app/` | Orchestrate ports, own transactions, add business context to failures | Import Express/`pg`/`fetch`; format HTTP responses |
| `domain/` | Pure functions and types; decide, classify, build replies | Any I/O, clock reads, `Math.random` (inject them) |
| `adapters/` | Talk to the outside world; translate its failures into port-level results | Business rules; leaking raw `fetch`/`pg` errors upward |

A handler that is more than ~15 lines is usually doing an `app` function's job. Error flow (who catches, who logs, once) is in the `resilience` skill — read it before writing a `try/catch`.

## Design judgement (apply principles to remove pain, not to add ceremony)

- **SRP = one reason to change.** Split a module when two unrelated change drivers touch it (e.g. Slack message formatting and retry policy). Don't split things that always change together.
- **DIP = the policy side owns the interface.** `ports/` lives next to `app/`, adapters implement it. Don't write an interface for a pure helper or a class with one implementation and no test seam; Rule of Three before adding an extension point.
- **Composition over inheritance.** No class hierarchies; shared behaviour is a function or an injected collaborator.
- **Model closed sets as discriminated unions** (`InteractionType`, `JobStatus`, `FailureKind`, `Outcome`) and branch with an exhaustive `switch` ending in `assertNever` — adding a variant then fails compilation everywhere it matters.
- **Brand identifiers.** `GuildId`, `ChannelId`, `InteractionId`, `JobId` are all strings; mixing them silently is a tenancy bug (passing a channel id where a guild id is scoped). `type GuildId = string & { readonly __brand: 'GuildId' }`, created only by the zod schema that validates them (snowflakes: `/^\d{17,20}$/`).
- **Fail fast at boundaries**, trust types inside. Validate once at the edge; don't re-validate in every function.
- **Don't block the event loop.** No `*Sync` fs/crypto calls in request or worker paths (argon2/scrypt are async); CPU-heavy work goes to a worker thread or is deliberately avoided.
- When you deliberately deviate from a principle (an abstraction skipped, a rule bent), leave a one-line comment or note in your report: what, instead what, why.

## Validation

- Validate at every boundary with zod: env, admin API bodies/params/query, interaction payload shape (after signature verification), LLM output, data read from JSON columns.
- Use `.strict()` on request-body schemas so unknown keys are rejected, not silently carried along (mass-assignment and prototype-pollution hygiene); set max lengths on every string and bounds on every number and array.
- Infer types from schemas (`z.infer`) so the runtime check and type can't drift. Shared request/response schemas live in `packages/shared` so the frontend uses the same types.
- Validation failure → 400 `VALIDATION_FAILED` with field names, never echoing the offending value.

## Database

- Migrations are versioned files run by a script (`npm run db:migrate`); never mutate schema at app start in production. Migrations are forward-only and safe to run twice.
- Tables, columns, constraints and indexes come from DESIGN §9 — `interaction.id` PK as the dedupe key, unique `job.interaction_id`, unique `command_rule (guild_id, command_name)`. Constraints do the correctness work; application checks are a convenience. Add check constraints for status enums.
- Every guild-scoped query filters on `guild_id` and is checked against `admin_guild` for the logged-in admin (mismatch → 404).
- Parameterised queries only (`$1, $2`) — never build SQL by string concatenation or template literals, including for `ORDER BY` / column names (map user input to a fixed allow-list instead).
- Keep the pool small (free-tier connection limits); set a connection timeout and a `statement_timeout` — a query with no timeout is the database version of a `fetch` with no `AbortSignal`. Use Neon's pooled endpoint if deploying there.
- Timestamps `timestamptz`, ids for Discord entities stored as `text` (snowflakes overflow JS numbers).
- Multi-statement changes use a single checked-out client with `BEGIN … COMMIT` and `ROLLBACK` in a `finally`-safe path; never two `pool.query` calls pretending to be one transaction.

## HTTP API

- Follow DESIGN §5/§8 exactly; where the design doesn't spell out a dashboard endpoint, choose conventionally and record it under "Assumptions" so the frontend agent can see it. Plural nouns, JSON, camelCase fields, ISO-8601 timestamps.
- Don't change a response shape the frontend already consumes without telling the frontend agent (and updating `packages/shared`); additive changes are safe, renames and removals are not.
- Pagination for logs: cursor-based (`?before=<id>&limit=50`) so a live-updating list doesn't skip/duplicate rows. Cap `limit` server-side.
- Errors use the shape in the `resilience` skill. Status codes: 400 validation, 401 no session, 403 bad/missing CSRF token, 404 not found **or not yours** (never reveal another tenant's guild exists), 409 conflict/version mismatch, 429, 500.
- `GET /healthz` (process up) and `GET /readyz` (DB reachable) — no auth, no secrets in output.

## Configuration and constants

- `config.ts` is the only reader of `process.env`; zod-validated, fail fast naming the missing variable (never its value). Every base URL, timeout, limit, interval and pool size is config with a sensible default for optional ones. Never hard-code a URL, port, timeout or credential.
- No magic numbers or strings in logic: a named constant (`REPLAY_WINDOW_MS = 5 * 60_000`) in the module that owns the meaning, or config if operators may tune it. Closed value sets (job status, failure kinds, error codes) are `as const` objects with a derived union type — not `enum`, and never `const enum` (it doesn't survive `isolatedModules`/esbuild transpilation, which Vitest uses). See `references/typescript-style.md`.

## Testing

- Vitest + Supertest against `createServer(deps)` with fake adapters, injected clock and random.
- Unit: `verify.ts`, rule evaluation, error classification, backoff calculation, redaction.
- Integration: signed interaction → DB rows + jobs; duplicate → no new rows; admin API auth/guild scoping. Use a real Postgres (local Docker or a Neon branch) rather than mocking SQL — the unique-constraint behaviour is the thing under test.
- Cover the unhappy path of every new function you write: the error branch, the empty input, the boundary value (0, max, max+1). A feature with only a happy-path test hasn't been tested.
- Name tests after the behaviour/acceptance criterion, not the function. Arrange–act–assert, one behaviour per test, no logic (loops/ifs) in tests.
- No test talks to real Discord/Slack/LLM — stub servers only. No test depends on wall-clock time or ordering of other tests.

## Style (short form — details in `references/typescript-style.md`)

- Small files, one responsibility; functions ≲30 lines, nesting ≤3 levels, early returns over `else` pyramids.
- No `any`; `unknown` + narrowing at boundaries; no `as` casts except directly after validation; no non-null `!` to silence the compiler; `@ts-expect-error` with a reason instead of `@ts-ignore`, and only with an issue note.
- Explicit return types on exported functions; explicit access modifiers on class members, `private`/`readonly` by default.
- Never leave a promise floating: `await` it or attach `.catch` that logs. Use `Promise.allSettled` when one failure must not cancel the rest.
- Name things in the domain's words (`mirrorNotification`, `triageResult`), not `data`, `info`, `handleStuff`. Booleans read as questions (`isExpired`, `hasMirror`).
- Comments explain *why* (a Discord quirk, a security reason), not what the code does. No dead code, no commented-out blocks, no `console.log` — use the logger.
- Prettier owns formatting (don't hand-format or argue about it); ESLint owns the rules above.
- Conventional commits: `feat(api): …`, `fix(interactions): …`, `test(jobs): …`.

## Before you report a step done

Typecheck, lint and tests pass; no new `any`/`as`/`!`/`@ts-*`; every new function has a failure-path test; no outbound call or query without a timeout; no new env var missing from `config.ts`, `.env.example` and the README table; no business logic in a handler. Anything pre-existing and broken is reported, not silently fixed or ignored.
