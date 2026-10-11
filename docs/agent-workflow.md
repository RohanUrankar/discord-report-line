# Agent workflow & tooling

How the build is orchestrated across AI agents. The design is `architecture/docs/DESIGN.md`; the invariants are in root `CLAUDE.md`. This file is imported into `CLAUDE.md`.

## Repo layout

- `apps/api` — Express + TypeScript backend (DESIGN §7 module tree lives in `apps/api/src`). See `apps/api/CLAUDE.md`.
- `apps/web` — Angular 21 (standalone, signals, zoneless) + Angular Material 3 dashboard. See `apps/web/CLAUDE.md`.
- `packages/shared` — zod schemas, API types, error codes and user-facing messages used by both.
- `scripts/` — `register-commands.ts`, `seed-admin.ts`.
- `architecture/docs/` — design (architect-owned); `architecture/docs/proposals/` — implementers' proposed changes.
- `docs/ai-journal.md` — running log of AI wrong turns (feeds `AI_NOTES.md`); `docs/verification/` — quality-verifier reports.

## Orchestration (main session)

1. Take the next step from DESIGN §16 whose predecessors are done. Steps 1–4 (the gradeable core) are solid before 5–6.
2. Delegate by owner, one step at a time, giving the step number plus anything learned from earlier reports:
   - `backend-implementer` — apps/api, packages/shared, scripts.
   - `frontend-implementer` — apps/web. Starts at Step 4; pass it the endpoint/schema list from the backend's reports. It can work against fixtures while the backend finishes the endpoints.
3. After every step touching interactions, the ledger, the worker or integrations, and before every deploy: `quality-verifier` (local), then again against the live URL. Route each finding back to the owning implementer.
4. Review the report and the diff, then commit one logical change per commit with Conventional Commits (`feat(api): …`, `fix(worker): …`, `test(ledger): …`, `feat(web): …`, `docs: …`). The history is graded: no "wip", no mixed giant commits.
5. Files in `architecture/docs/proposals/` go to the human/architect before dependent work continues. Accepted proposals are merged into DESIGN.md.

## Skills (`.claude/skills/`)

| Skill | Used by | Purpose |
|---|---|---|
| `contract-first` | both implementers | Read DESIGN by section, criteria → tests, proposals, definition of done, report format |
| `discord-interactions` | backend, verifier | Signature/PING/defer/modal/component traps, lookup procedure, API cheat sheet |
| `resilience` | backend | Outbox/worker code pitfalls, timeouts (HTTP and DB), degradation, error flow (log once at the edge), Node/Postgres error codes, AppError + API error shape |
| `security-secrets` | all | Secret inventory, auth/session/CSRF, tenant isolation, SSRF on webhook URLs, crypto/TLS rules, headers/CSP, supply chain, threat model + anti-pattern scan (references/) |
| `observability` | backend | pino + redaction, security-event vs operational log classification, history from interaction/action/job/job_attempt, health |
| `backend-guidelines` | backend | Hexagonal layout in practice, design judgement, validation, DB, testing, TypeScript style rulebook + tsconfig/ESLint enforcement (references/) |
| `frontend-guidelines` | frontend | Angular 21 + Material 3 conventions, component design, browser security, error display, constants/performance, API client, testing |
| `state-management` | frontend | Signals stores, polling live feed, optimistic saves, auth state |
| `ux-accessibility` | frontend | Task-first screens, four states, live log UX, WCAG 2.2 AA |
| `user-facing-messages` | both | One voice for Discord replies, Slack mirror and dashboard; shared error-message map |
| `ai-journal` | all | Log AI wrong turns immediately; draft AI_NOTES.md from them |
| `quality-bar-check` | verifier | `attack.mjs` (forged/replayed/duplicate/oversized), `stub-downstream.mjs` (down/slow/429/404/flaky), live checklist |
| `free-tier-deploy` | main session | No-card hosting, Discord portal, cold starts, same-origin cookies, env vars |

## Hooks (`.claude/hooks/`, Node scripts in exec form so they run the same on Windows)

| Hook | Where | Effect |
|---|---|---|
| `secret-scan.mjs` | PreToolUse Write/Edit (all) | Blocks writes to `.env*` (except `.env.example`) and content that looks like a Discord token, webhook URL, API key, hosted DB URL or private key |
| `guard-bash.mjs` | PreToolUse Bash/PowerShell (all) | Blocks reading/staging `.env`, `--no-verify`, force-push, `reset --hard`, `clean -f` |
| `format-on-edit.mjs` | PostToolUse Write/Edit (all) | Runs Prettier on the touched file once Prettier is installed |
| `scope-guard.mjs` | per agent | Limits each agent's writable paths (always allows `docs/ai-journal.md` and `architecture/docs/proposals/`) |
| `verify-workspace.mjs` | per agent Stop | Runs typecheck/lint/test for the agent's workspaces; blocks finishing up to 3 times, then lets it stop and report |

Project agent hooks only run after the workspace trust dialog is accepted for this folder.

## Working agreements

- Look up version-sensitive APIs (Discord, Angular, Material, Express, provider free tiers) via Context7 or official docs; don't rely on memory.
- When an AI assumption proves wrong, log it in `docs/ai-journal.md` at once.
- Keep current: `README.md`, `.env.example`, `AI_NOTES.md`, and these context files (they are submitted as-is).
