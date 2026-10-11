# 0003 — Dependency direction between domain/ and packages/shared, plus two §11.3 step-table gaps

**Status:** Accepted, 2026-10-11 (DESIGN rev 3: §7, §8.3, §11.3)
**Decision:** A — Option 1 as proposed; the contradiction came from the architect's rev 2, not from 0002. B1 — job `dead`, interaction `followed_up`, written as one "finish" rule that also covers the fallback path (failed mirror + fallback posted → job `dead`, interaction `fallback_posted`). B2 — skip on `failed` as proposed. Also fixed: step 3's skip condition now includes "token is NULL", which the step 4 retry note already assumed.
**Raised by:** backend-implementer, at the start of `domain/types.ts` and `domain/rules.ts` against DESIGN rev 2
**Blocks:** `domain/types.ts`, `domain/rules.ts`, `domain/router.ts`, `domain/reply.ts` and `packages/shared`. Part B blocks the worker (app module) only.

## A. Domain ↔ packages/shared: rev 2 contradicts itself and creates a cycle (blocking)

### Context

| DESIGN rev 2 | Says |
|---|---|
| §7, line 337 | "`domain` imports nothing outside `domain`." (unchanged in rev 2) |
| §7, line 311 | `types.ts # … enums (§8.3); rule schemas live in packages/shared` |
| §8.3, line 525 | `// packages/shared/rules.ts — zod, .strict()`: `StatusRuleConfig`, `ReportRuleConfig`, `RULE_SCHEMAS`, `DEFAULT_RULES` |
| §8.3, line 551 | `// domain/rules.ts — pure`: `validateRule` / `evaluate` validate against those schemas and fall back to `DEFAULT_RULES` |
| §8.3, line 589 | "Every enum is an `as const` tuple in `domain/types.ts` (**exported to** `packages/shared` for the dashboard)" |

Three problems follow:
1. **§7 is violated.** `domain/rules.ts` must import `RULE_SCHEMAS` and `DEFAULT_RULES` from `packages/shared`, which is outside `domain`. Rev 2 does not amend the dependency rule or say how domain may depend on shared.
2. **The packages form a cycle.** Schemas flow shared → domain (line 525/551), while enums flow domain → shared (line 589). `packages/shared` would then depend on `apps/api`, and `apps/api` on `packages/shared`. A shared library depending on an app also means the Angular build could pull backend modules (e.g. `domain/signature.ts`, which imports `node:crypto`) into its dependency graph.
3. **zod inside domain is unaddressed.** `validateRule` runs the zod schemas at runtime, so zod executes in domain code. zod does no I/O, but §7's "imports nothing outside domain" read literally forbids it. The `backend-guidelines` skill allows "zod / packages/shared types" in domain, but DESIGN does not.

The orchestrator's relay for this turn also says to put the enum tuples in `packages/shared`, which contradicts §8.3 line 589. That confirms the direction is undecided.

My own proposal 0002 started this split. It put enums in `domain/types.ts` and the rule schema in `packages/shared` without settling the direction. See the ai-journal entry.

### Proposal (recommended: Option 1)

**Option 1: `packages/shared` is a leaf package, and domain may import it.**
- `packages/shared` (`@report-line/shared`) contains only pure, I/O-free code: zod schemas, `as const` enum tuples, `DEFAULT_RULES`, error codes and messages. It imports only `zod` and never anything from `apps/*`.
- It is the single home of the §8.3 enum tuples and rule schemas. `domain/types.ts` re-exports the enums and adds the backend-only types (`Action`, `Actor`, `Tenant`, `MessageRef`).
- Amend the §7 dependency rule to: "`domain` imports only `domain`, `@report-line/shared` and `zod` (all I/O-free)."
- Enforce it with lint. `packages/shared` gets a rule banning imports of `apps/*`, I/O modules and `node:*`. Domain's `no-restricted-imports` allow-list adds `@report-line/shared` and `zod`.
- Change §8.3 line 589 to "an `as const` tuple in `packages/shared` (re-exported by `domain/types.ts`)".

**Option 2: domain owns everything, and shared re-exports from domain.** This keeps §7 literal. But `packages/shared` would then depend on `apps/api`, and the frontend would build against a backend package. Rejected.

**Option 3: inject the validator into domain.** `evaluate(command, ctx, rule, validate)` keeps domain free of imports, but it changes the §8.3 signature and adds a port for a pure function. Rejected as ceremony.

**Option 4: duplicate the schemas and enums in domain and shared, with a test that keeps them identical.** That is two sources of truth for a contract the frontend binds to. Rejected.

### Consequences (Option 1)

- §7 dependency rule and §8.3 line 589 are reworded. No interface signature changes.
- Workspace: add `packages/shared` to the root workspaces, depend on it from `apps/api` (and later `apps/web`), and add `zod` as a dependency of `packages/shared`.

## B. §11.3 step table: two inconsistencies (does not block the domain; blocks the worker)

1. **The outcome after a fatal mirror is contradictory.** Step 2 fatal (line 883) says "continue to step 3 … then job `dead` with reason". Step 3 success (line 884) says "job `done`, … interaction `followed_up`". When the mirror fails fatally and the follow-up succeeds, the job could be either `dead` or `done`.
   *Recommendation:* job `dead` (`last_error` = the mirror reason, so the failure stays on the dashboard's failure list), interaction `followed_up` (the user did get an answer), token cleared. The step 3 "on success" cell becomes "job `done` (or `dead` if the mirror failed fatally)".
2. **A fatally failed mirror is retried on a later pass.** Step 2's skip condition is `mirror_status IN ('sent','skipped')`, which leaves out `'failed'`. If the mirror fails fatally and the follow-up then fails retryably, the next pass calls the rejected webhook again. That contradicts "fatal = never retried" (CLAUDE.md, §8.1).
   *Recommendation:* skip if `mirror_status IN ('sent','skipped','failed')`.

Neither change affects domain code or any §8 signature.
