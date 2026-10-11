---
name: contract-first
description: How implementer agents find, read and follow the architect's design (architecture/docs/DESIGN.md plus the invariants in CLAUDE.md), turn a build-plan step's WHEN/SHALL acceptance criteria into tests, define "done", and handle disagreements with the design by writing a proposal file instead of silently deviating. Use this at the start of every implementation task, whenever you are assigned a build-plan step, when the design seems incomplete or wrong, and before reporting a step as finished.
---

# Contract-first implementation

The architect owns the design; implementers own the code. That split only works if the design is treated as the contract and every departure from it is visible. Graders read both the design and the git history, so silent drift between them reads as "the AI wandered off".

## 1. Where the design lives

- **`CLAUDE.md`** (root) — the architect's short list of invariants. Always in context. Never trade one away to "get it working".
- **`architecture/docs/DESIGN.md`** — the single source of truth. If it has moved, find it with a glob for `**/DESIGN.md` outside `node_modules`.
- **`architecture/docs/*.mmd`** — diagrams referenced by the design.

Section map of DESIGN.md (read by section, not end to end):

| § | Contents | Read when |
|---|---|---|
| 1 | Functional reqs (F-xx), NFRs (NFR-xx), QA priority | Every step: know which IDs your step serves |
| 2 | Context, containers, components, data flow + trust boundaries | Wiring/new component |
| 3 | The three credentials | Anything touching auth to Discord |
| 4 | Discord mechanics (verified against docs) | Any interaction code |
| 5 | Commands and interaction contracts, response decision table | Command/component/modal handlers |
| 7 | Module structure (domain / app / ports / adapters / http) | Every backend step — where code goes |
| 8 | Component contracts (TypeScript interfaces) | Copy signatures exactly |
| 9 | Data model, constraints, indexes, token handling, secrets at rest | Migrations, repos |
| 10 | Sequence diagrams incl. failure branches | The flow your step implements |
| 11 | State machines (job lifecycle, response lifecycle) | Worker, statuses shown on dashboard |
| 13 | STRIDE threat model, derived security requirements SR-1..6 | Anything at a trust boundary |
| 14 | Failure catalogue per integration | Adapters, retries |
| 15 | ADRs 0001–0004 | Before questioning a decision |
| 16 | Build plan: steps with Goal, Delivers, Acceptance, Verify | Your assignment |

The design's module tree (`src/`, `scripts/`) maps to `apps/api/src/` and `scripts/` in this repo; the Angular SPA lives in `apps/web/`; shared schemas/types in `packages/shared/`.

## 2. Read only what the step needs

For an assigned step ("Step 3"):

1. §16 → the step's Goal, Delivers, Acceptance, Verify. Confirm earlier steps are done (git log / existing code) before starting.
2. The §5/§8/§9 entries for what the step touches. Names, signatures, column names, status values and HTTP codes are copied exactly.
3. The §10 sequence and §11 state machine for the flow, **including its failure branch** — that branch is part of the step, not a follow-up.
4. §13/§14 rows for the components you touch.

Don't reread the whole document for every step; it wastes context and invites "improving" parts you weren't asked to touch.

## 3. Acceptance criteria → tests

Each `WHEN <trigger> THE SYSTEM SHALL <response>` becomes at least one automated test whose name echoes the criterion:

```ts
it('WHEN the same interaction id is delivered 10 times concurrently THE SYSTEM SHALL create one interaction row and one job', ...)
```

If a criterion can't be automated (e.g. "the URL is accepted in the Developer Portal"), say so in your report and give the exact manual check. Run the step's `Verify:` yourself.

## 4. When the design is wrong or silent

- **Small gap, obvious answer, no contract change** (helper name, log field, file split inside a module): decide and list it under "Assumptions" in your report.
- **Anything that changes an interface in §8, the data model, an invariant in CLAUDE.md, a dependency, a security property, or a §10 flow**: do not implement your alternative. Write `architecture/docs/proposals/NNNN-<kebab-title>.md` (Status: Proposed · Context · Proposal · Options considered · Consequences), then stop and report. The orchestrator/architect accepts it into DESIGN.md or rejects it.

Why so strict: the frontend agent builds against the same contracts in parallel. A backend that quietly renames a field breaks the other half in a way neither agent notices until the end-to-end test.

## 5. Definition of done

- Every acceptance criterion has a passing test or a stated manual check.
- `npm run typecheck`, `npm run lint`, `npm test` pass in the workspace you touched (the stop hook runs them anyway).
- The step's `Verify:` was run and matched.
- The CLAUDE.md "Verify these before calling anything done" items relevant to your step hold.
- No secrets, no `console.log` debugging, no commented-out code, no silent `TODO`.
- Any AI wrong turn hit during the step is logged via `ai-journal`.

## 6. Report back in this shape

```
## Step N: <title> — DONE | BLOCKED
Serves: F-xx, NFR-xx, SR-x
Criteria
- WHEN … SHALL …  → test `file.test.ts › name` ✅
- WHEN … SHALL …  → manual: <exact check>
Files changed: <list>
Verify output: <one-line summary>
Assumptions: <small decisions you made>
Proposals: <path or "none">
Journal entries: <count or "none">
Follow-ups: <anything the next step must know>
```

Keep it short — the orchestrator uses it to choose the next delegation and to write the commit message.
