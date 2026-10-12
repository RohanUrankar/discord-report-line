# AI notes

Sources: the git history, `architecture/docs/DESIGN.md`, and `docs/ai-journal.md` (written at the moment each AI mistake happened).

## Tools, models and how the work was split

- **Claude Code** was the only AI tool used for design, code, tests and docs. Commit trailers show Claude Opus 5.5 on the first five commits (design import, workspace scaffold, shared enums, domain types, signature and retry classification) and Claude Sonnet 5.5 on the remaining 72.
- **Design: me, with Claude as a design assistant.** I worked through requirements, quality priorities, architecture, data model, threat model, ADRs and the build plan with Claude, and made the calls that shape the system. The result is `DESIGN.md` plus the short list of invariants in `CLAUDE.md`.
- **Implementation: Claude agents, one build step at a time.** A main session delegated each step to a `backend-implementer` or `frontend-implementer` agent, then ran an independent, read-only `quality-verifier` agent that attacks the endpoint and simulates outages. I reviewed the diffs and committed one logical change at a time.
- **Guard rails are code, not requests.** Hooks in `.claude/hooks/` block writing anything that looks like a secret, block reading `.env`, restrict each agent to its own folders, format on edit, and re-run typecheck, lint and tests before an agent may report "done". Implementers cannot edit the design; when they disagreed with it they had to write a proposal and stop (five were raised, all reviewed). DESIGN §17 explains the full setup.
- Library and API details were checked against current docs (Context7, Discord's developer docs, Google's Gemini docs) rather than recalled.

## Key decisions I made

1. **Postgres as both the database and the job queue (transactional outbox), no Redis or broker.** The interaction and its job are written in one transaction before Discord gets its reply, so nothing is lost and nothing runs twice, with one datastore to operate. A broker would have added a second failure mode for less than one message a second (ADR-0001).
2. **One managing admin per server, first claim wins.** The design had left open who may connect a server; letting any admin claim any server would let one take over another's. The database primary key enforces it. The known gap, that connecting does not prove Discord ownership, is documented; Discord OAuth2 with a `MANAGE_GUILD` check is the fix.
3. **A Discord follow-up that fails with 401 or 404 is never retried.** It goes straight to a channel post with the bot token. Retrying a deterministic failure wastes attempts and counts towards Discord's invalid-request limit, which can get the bot's IP banned (DESIGN §11.4). Related: I chose polling every 5 seconds over server-sent events, because free hosts often buffer long-lived streams (ADR-0006).

## The hardest bug: saved rules that the bot never read

**What the AI produced.** Step 4 delivered command configuration: a rules editor, strict validation, rows saved to `command_rule`, and a full set of passing tests. It looked finished.

**How it was noticed.** The audit at the start of Step 5 searched for every caller of the rule evaluator. There was exactly one, called with hard-coded defaults, next to a comment from Step 3 saying "No rule store yet: every command is enabled with its default config". Switching `/report` off in the dashboard changed nothing in Discord. The quality verifier found the same thing independently.

**Why it was wrong.** Saving rules and using rules had separate acceptance criteria. Every test proved a row was written; no test proved a row was ever read. Green tests, dead feature.

**Fix.** One function, `resolveAction`, is now the only way a stored rule becomes behaviour, used by commands, the form submit and the buttons. It validates the stored row and falls back to defaults if it is corrupt. New tests change the row with SQL and check that the next command behaves differently.

**Guard rail.** A rule for this project: every "configurable X" feature needs one test that changes X and observes the behaviour, not just the stored row.

Runners-up, all in the journal: Discord's recommended `verifyKey` is async, so used as a boolean it would have accepted every forged request (entry 2); the landing page hung for ever in a real browser while 200 unit tests passed, because two components raced to load the same store (entry 29); tests broke on their own once real time passed a hard-coded test clock (entry 31).

## What I would add with more time

- Deploy, then soak-test the retry and fallback paths against real Discord and Slack, and make one live Gemini call (only stubs so far).
- Fill the Discord reply before the Slack mirror, so a slow Slack never leaves the user on "thinking…".
- Discord OAuth2 sign-in with a `MANAGE_GUILD` check, replacing first-claim-wins.
- A CI pipeline so typecheck, lint and tests run on every push, not only through agent hooks.
- Close the one duplicate-post gap in the Slack mirror (Slack webhooks have no idempotency key).
- A database-backed login throttle and a retention sweep for old jobs.
