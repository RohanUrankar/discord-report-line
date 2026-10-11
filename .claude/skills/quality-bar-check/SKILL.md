---
name: quality-bar-check
description: Adversarial verification of the Discord bot against the assignment's quality bar — forged/unsigned/replayed requests, PING, duplicate and concurrent duplicate interactions, the 3-second window, mention injection, oversized bodies, and downstream failures (mirror/LLM/Discord down, slow, 429, 404) — using bundled scripts attack.mjs (signed request attacker) and stub-downstream.mjs (fake Slack/Discord/LLM with failure modes), plus a live-URL end-to-end checklist. Use this after every backend build-plan step that touches interactions, jobs or integrations, before any deploy, when asked "is it robust / does it pass the quality bar / would graders break it", or when verifying the deployed URL.
---

# Quality-bar check

Graders weigh, right after "does it work end-to-end", "how it behaves under the unhappy paths: forged/unsigned request, duplicate interaction, downstream briefly down, slow work". This skill is how we find out first. Your job is to try to break the system, not to confirm it works — report what you observed, with evidence, and never "fix" code yourself.

## Scripts

- `scripts/attack.mjs` — sends crafted requests to an interactions endpoint and prints ✅/❌/⚠️/👀 per check, exit code 1 on any failure. `--gen-key` prints a test keypair; `--private-key <hex>` (or env `ATTACK_PRIVATE_KEY`) enables the signed checks; `--command <name>` picks the slash command; `--json` for machine-readable output.
- `scripts/stub-downstream.mjs` — fake downstream with modes `ok | slow | error | ratelimit | gone | flaky`, switchable at runtime (`POST /__mode?m=…`), request counts at `/__stats`.

Run them with `node .claude/skills/quality-bar-check/scripts/<script>`.

## A. Local run (full suite)

1. `node …/attack.mjs --gen-key` → put `DISCORD_PUBLIC_KEY=<public>` in the API's local env for this run (shell env or `.env.test`, never `.env` for prod values) and keep `ATTACK_PRIVATE_KEY` in your shell.
2. Start the stub: `node …/stub-downstream.mjs --port 4010 --mode ok`. Point every downstream base URL in the API's env at it (mirror webhook, Discord API base, LLM base). If the API has no env var for one of these, that's a finding — downstreams must be configurable.
3. Start the API locally against a dev database.
4. `node …/attack.mjs --url http://localhost:<port>/interactions --command <cmd>` for each registered command.
5. For each 👀 result, verify in the DB or via the dashboard API: exactly one interaction row and one set of jobs for that id.

## B. Downstream failure scenarios

For each, send one signed command with attack.mjs (any passing command check does this) and then inspect jobs/events in the DB or dashboard:

| Stub mode | Expected behaviour |
|---|---|
| `ok` | Reply/follow-up and mirror succeed; events show each action. |
| `error` (503) for ~30s, then `ok` | Mirror retried with growing gaps, then succeeds; attempts visible. Discord user unaffected. |
| `flaky --fail-count 2` | Succeeds on attempt 3. |
| `ratelimit` | Next attempt scheduled ≈ `retry_after`, not hammered (check `/__stats` count). |
| `gone` (404 10015) | Job dead after 1 attempt, readable reason in dashboard; no retry loop. |
| `slow --delay 30000` on the LLM URL | Discord response still < 3s (deferred); triage times out per config; response completes without tags. |
| stub stopped (connection refused) | Treated as transient; retries; recovers when stub restarts. |
| API process killed mid-retry, restarted | Pending jobs resume; nothing duplicated or lost. |

## C. Deployed URL (unsigned + real Discord)

Production verifies with Discord's real public key, so only unsigned checks apply:

`node …/attack.mjs --url https://<host>/interactions` → all unsigned checks must pass (signed ones skip).

Then the real end-to-end path, by hand in the test server:
- [ ] Endpoint saved in Developer Portal (proves PING + invalid-signature handling).
- [ ] Each slash command: reply appears; channel post appears where configured; mirror arrives in Slack/second channel; dashboard shows the row and its event timeline without reload.
- [ ] Button click / modal submit (if built) recorded and acted on once.
- [ ] After ≥ 20 min idle (cold start), a command still gets a response, not "This interaction failed".
- [ ] Dashboard requires login; logged-out API calls return 401; secrets not visible in page source, network responses, or the JS bundle (`grep` the built `dist/` for token/webhook patterns).

## Report format

```
## Quality-bar report — <local|deployed> — <date> — commit <sha>
attack.mjs: <N passed / N failed / N warn / N manual> (paste the ❌/⚠️ lines verbatim)
Duplicate checks: <one row confirmed? how>
Downstream scenarios: <table: scenario → observed → ✅/❌>
Deployed checklist: <ticked items, failures>
Findings (most severe first):
1. <what failed> — evidence: <output/log/query> — likely cause: <file/area> — suggested owner: backend|frontend
```

Every ❌ is a finding for the orchestrator; it also belongs in `docs/ai-journal.md` if it was AI-written code that looked correct (use the `ai-journal` skill).
