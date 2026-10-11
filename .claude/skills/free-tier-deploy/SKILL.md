---
name: free-tier-deploy
description: Deploying this Express API + Angular dashboard + Postgres + Discord app entirely on no-credit-card free tiers (Render / Vercel / Cloudflare / Netlify, Neon / Supabase, Slack or Discord webhooks, Gemini / Groq), including Discord Developer Portal setup, command registration, environment variables, same-origin cookie setup, cold-start mitigation for the 3-second window, and the README deployment section. Use this whenever the task is deploying, configuring hosting, setting env vars on a host, wiring the Discord portal, registering commands, debugging "works locally but not deployed", or writing the README's deploy/run instructions.
---

# Free-tier deployment

Hard constraint from the assignment: **no credit card anywhere**. If a signup asks for card details, stop and pick another option. Free-tier limits change often — verify current limits on the provider's pricing page (WebFetch) before stating them in the README, and say "as of <date>".

Follow the hosting ADR. This skill covers the traps common to any choice.

## Trap 1 — cold starts vs the 3-second window

Free web services that sleep when idle (e.g. Render free instances spin down after a period of inactivity and take tens of seconds to wake — verify current numbers) will make the first command after idle fail with "This interaction failed". Graders will hit it cold.

Options (the ADR picks one; document it in the README):
- A host without cold starts for the interactions endpoint (edge/serverless functions — but then background work needs `waitUntil` or an external trigger to drain the outbox).
- Keep-alive: a free external cron/uptime pinger hitting `/healthz` more often than the idle timeout. Check the host's terms and its monthly free-hours budget (one service 24/7 must fit).
- Both: a tiny always-warm edge function that verifies, records, and defers, while the slower worker runs elsewhere.

Verify after deploy: wait past the idle timeout, run a command, it must respond.

## Trap 2 — cookies across origins

If the Angular app is on `app.vercel.app` and the API on `api.onrender.com`, those are different *sites*: session cookies need `SameSite=None; Secure`, and some browsers block third-party cookies anyway → login "works" then every call is 401. Prefer same-origin:
- Express serves the built Angular `dist/` (one service), or
- the frontend host rewrites `/api/*` to the API (e.g. Vercel rewrites), so the browser only sees one origin.

## Trap 3 — env drift

Every variable in `config/env.ts` must exist in: `.env.example` (placeholder), the host's env settings, and the README table. Set `NODE_ENV=production`, the public base URL (for OAuth redirects and links), and CORS origin to the exact deployed origin.

## Database (Neon / Supabase)

- Create project → copy the connection string into the host env only. Use the pooled endpoint if the ADR says so; `sslmode=require`.
- Run migrations from your machine or a release command (`npm run db:migrate`) — not on every app boot.
- Free tiers suspend idle compute; the first query after idle is slower. Keep DB timeouts sensible and keep that query out of the 3-second path if possible (or count it in the budget).

## Discord Developer Portal checklist

1. New Application → note **Application ID** and **Public Key** (General Information).
2. Bot tab → reset/copy **Bot Token** → host env only. Public bot toggle off if only you should install it.
3. Installation / OAuth2 → scopes `bot` + `applications.commands`; minimal permissions (View Channel, Send Messages). Add your redirect URI if the connect flow uses a callback.
4. Deploy the API first, then set **Interactions Endpoint URL** to `https://<host>/interactions` and save. Discord sends a PING and an invalid-signature probe; saving fails unless both are handled — if it fails, check host logs for 401/200 on those two requests.
5. Register commands: `npm run register-commands` (guild-scoped for the test server for instant updates).
6. Create the test server, install the bot, create the post channel and the mirror target (Slack Incoming Webhook or a Discord channel webhook). Generate an invite link for graders.

## Second channel

Slack Incoming Webhook or Discord channel webhook — both "paste a URL". The URL is a secret: host env (or encrypted per-guild DB value), never in the repo or client.

## LLM (stretch)

Gemini (Google AI Studio key) or Groq — free tiers, no card. Check current model names and free rate limits via their docs; rate limits on free tiers are low, so the AI job must handle 429 like any other downstream.

## Post-deploy smoke test

`node .claude/skills/quality-bar-check/scripts/attack.mjs --url https://<host>/interactions` (unsigned checks), then the deployed checklist in `quality-bar-check`. Also `grep -rE "hooks.slack.com|discord(app)?.com/api/webhooks|Bot [A-Za-z0-9]" apps/web/dist` must return nothing.

## README deploy section should state

Where each piece runs (with URLs), how cold starts are handled, which env vars go where, how to register commands, how to add the bot to a server, the throwaway admin login, and free-tier limitations a grader might notice (first DB query after idle, rate limits).
