# The Report Line

A Discord bot that takes reports from a server, records each one exactly once, mirrors it to a team channel, and shows an admin dashboard of what happened. Built as a Node.js + TypeScript + Express API, an Angular dashboard and PostgreSQL. The design lives in [`architecture/docs/DESIGN.md`](architecture/docs/DESIGN.md); the rules every change must respect are in [`CLAUDE.md`](CLAUDE.md).

**Status: build step 1 of 6 (walking skeleton).** The endpoint verifies Discord's signature, answers the PING Discord sends when you save the URL, and replies to `/status`. Reports, the ledger, the worker, Slack mirroring and the dashboard come in later steps; this README grows with them.

## What works today

| Request                                                   | Result                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Missing, malformed, forged or tampered signature          | `401`, no body, nothing stored                                                     |
| Correct signature but a timestamp more than 5 minutes off | `401` (replay protection)                                                          |
| PING (type 1)                                             | `200 {"type":1}`                                                                   |
| `/status`                                                 | Inline, private reply with report counts (zeros until the ledger exists in Step 2) |
| Any other command, a button, a DM                         | A short private notice                                                             |
| `GET /healthz`                                            | `200 {"status":"ok"}`                                                              |

## Run it locally

Requires Node 22.12 or newer.

```bash
npm install
cp .env.example <your local env file>   # then fill in the values (see below). Never commit it.
npm run dev
```

The server listens on `PORT` (default 3000). `npm test`, `npm run typecheck` and `npm run lint` run across both workspaces.

### Environment variables

Every variable is validated at startup; a bad or missing one stops the process and names the variable (never its value). Only `.env.example` is committed.

| Variable               | Used by         | Required | Default                       | Notes                                                                 |
| ---------------------- | --------------- | -------- | ----------------------------- | --------------------------------------------------------------------- |
| `DISCORD_PUBLIC_KEY`   | server          | yes      |                               | Developer Portal, General Information, Public Key (64 hex characters) |
| `PORT`                 | server          | no       | `3000`                        |                                                                       |
| `LOG_LEVEL`            | server          | no       | `info`                        | `fatal` `error` `warn` `info` `debug` `trace` `silent`                |
| `REPLAY_WINDOW_MS`     | server          | no       | `300000`                      | Oldest `X-Signature-Timestamp` accepted                               |
| `STATUS_TIMEOUT_MS`    | server          | no       | `1500`                        | How long `/status` waits for its counts before replying "try again"   |
| `DISCORD_APP_ID`       | register script | yes      |                               | Developer Portal, General Information, Application ID                 |
| `DISCORD_GUILD_ID`     | register script | yes      |                               | Your test server's ID                                                 |
| `DISCORD_BOT_TOKEN`    | register script | yes      |                               | A real secret. Environment only; never logged or committed            |
| `DISCORD_API_BASE_URL` | register script | no       | `https://discord.com/api/v10` | Point at a stub in tests                                              |
| `DISCORD_TIMEOUT_MS`   | register script | no       | `5000`                        |                                                                       |

## Connect it to Discord

Discord needs a public HTTPS URL, so while developing you expose your laptop with a tunnel.

1. **Create the app.** In the [Developer Portal](https://discord.com/developers/applications) create an application. Copy the Application ID and Public Key. On the Bot page, reset the token and copy it. Put the three values, plus your test server's ID, in your local env file.
2. **Start the server:** `npm run dev`.
3. **Start a tunnel** in a second terminal. Either works; the URL changes each run unless you set up a named tunnel.
   - Cloudflare quick tunnel (no account needed): `cloudflared tunnel --url http://localhost:3000`
   - ngrok: `ngrok http 3000`
4. **Save the URL.** In the Developer Portal, General Information, set _Interactions Endpoint URL_ to `https://<your-tunnel-host>/interactions` and save. Discord sends a signed PING plus a deliberately bad signature; the save succeeds only if the server answers the first and rejects the second.
5. **Register the command:** `npm run register-commands`. Guild commands appear instantly.
6. **Invite the bot** with the OAuth2 URL generator: scope `bot`, permissions _View Channels_ and _Send Messages_. Then run `/status` in the server.

## Layout

```
apps/api/src
  domain/      pure logic: signature, router, reply builders, rules, retry policy
  app/         orchestration through ports (the interactions controller)
  ports/       interfaces the app depends on
  adapters/    implementations (Discord HTTP, stubs)
  http/        Express wiring, raw body on /interactions only, logging, error handler
  config.ts    the only reader of environment variables
packages/shared  zod schemas and enums used by the API and the dashboard
scripts/         register-commands
```

## Deployment

Not yet deployed. The hosting plan and deployed URL will be added in Step 6.

## Deliverables still to come

`AI_NOTES.md` (tools, decisions, the hardest bug, next steps), a test server invite and a throwaway admin login. The running log of AI wrong turns that feeds `AI_NOTES.md` is [`docs/ai-journal.md`](docs/ai-journal.md).
