# The Report Line

A Discord bot that takes reports from a server, records each one exactly once, mirrors it to a team channel, and shows an admin dashboard of what happened. Built as a Node.js + TypeScript + Express API, an Angular dashboard and PostgreSQL. The design lives in [`architecture/docs/DESIGN.md`](architecture/docs/DESIGN.md); the rules every change must respect are in [`CLAUDE.md`](CLAUDE.md).

**Status: build step 2 of 6 (record + dedupe + outbox).** The endpoint verifies Discord's signature, answers the PING Discord sends when you save the URL, and replies to `/status`. Every answered command is now written to Postgres exactly once before the reply. Reports, the worker, Slack mirroring and the dashboard come in later steps; this README grows with them.

## What works today

| Request                                                   | Result                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Missing, malformed, forged or tampered signature          | `401`, no body, nothing stored                                          |
| Correct signature but a timestamp more than 5 minutes off | `401` (replay protection)                                               |
| PING (type 1)                                             | `200 {"type":1}`                                                        |
| `/status`                                                 | Recorded, then an inline private reply with this server's report counts |
| An unknown or turned-off command                          | Recorded, then a short private notice                                   |
| The same interaction delivered again                      | Not recorded again; answered normally                                   |
| The database is down or too slow                          | A private "we couldn't log that" notice within 3 s, never a 500         |
| A button, a DM                                            | A short private notice (not recorded yet)                               |
| `GET /healthz`                                            | `200 {"status":"ok"}`                                                   |

## Run it locally

Requires Node 22.12 or newer.

```bash
npm install
cp .env.example <your local env file>   # then fill in the values (see below). Never commit it.
docker compose up -d db                  # local Postgres, see "Database" below
npm run db:migrate
npm run dev
```

The server listens on `PORT` (default 3000). `npm test`, `npm run typecheck` and `npm run lint` run across both workspaces.

### Database

Postgres 16 is the only datastore. For local work use Docker Compose (Docker Desktop must be running), or any Postgres you own.

1. In your local env file set `POSTGRES_PASSWORD` to a password you choose, and make the two URLs use it:
   `DATABASE_URL=postgresql://report_line:<password>@localhost:5432/report_line` and
   `DATABASE_URL_TEST=postgresql://report_line:<password>@localhost:5432/report_line_test`.
2. `docker compose up -d db` starts it (the first start also creates the `report_line_test` database the tests wipe).
3. `npm run db:migrate` applies `apps/api/migrations/*.sql` in order and records them in `schema_migrations`. It is safe to run twice, and the server never migrates on its own.
4. `npm test` needs `DATABASE_URL_TEST`; without it the database tests fail loudly instead of skipping. It must differ from `DATABASE_URL`, because the tests empty it.

For a hosted database (for example Neon) use its pooled connection string with `?sslmode=require` and a separate branch or database for `DATABASE_URL_TEST`.

### Environment variables

Every variable is validated at startup; a bad or missing one stops the process and names the variable (never its value). Only `.env.example` is committed.

| Variable                            | Used by         | Required   | Default                       | Notes                                                                   |
| ----------------------------------- | --------------- | ---------- | ----------------------------- | ----------------------------------------------------------------------- |
| `DISCORD_PUBLIC_KEY`                | server          | yes        |                               | Developer Portal, General Information, Public Key (64 hex characters)   |
| `PORT`                              | server          | no         | `3000`                        |                                                                         |
| `LOG_LEVEL`                         | server          | no         | `info`                        | `fatal` `error` `warn` `info` `debug` `trace` `silent`                  |
| `REPLAY_WINDOW_MS`                  | server          | no         | `300000`                      | Oldest `X-Signature-Timestamp` accepted                                 |
| `STATUS_TIMEOUT_MS`                 | server          | no         | `1500`                        | How long `/status` waits for its counts before replying "try again"     |
| `DATABASE_URL`                      | server, migrate | yes        |                               | `postgresql://...`. A real secret: environment only, never logged       |
| `DATABASE_URL_TEST`                 | tests           | for tests  |                               | A separate throwaway database the tests may wipe; must differ           |
| `POSTGRES_PASSWORD`                 | docker compose  | for Docker |                               | Password of the local container's `report_line` user                    |
| `RECORD_TIMEOUT_MS`                 | server          | no         | `1200`                        | Recording + status read must together fit the 3 s window (sum max 2800) |
| `DB_POOL_MAX`                       | server          | no         | `5`                           | Free-tier Postgres allows few connections                               |
| `DB_CONNECTION_TIMEOUT_MS`          | server          | no         | `1000`                        | Waiting for a connection                                                |
| `DB_STATEMENT_TIMEOUT_MS`           | server          | no         | `1500`                        | Enforced by Postgres per statement                                      |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | server          | no         | `5000`                        | Postgres kills a session that opens a transaction and goes quiet        |
| `DISCORD_APP_ID`                    | register script | yes        |                               | Developer Portal, General Information, Application ID                   |
| `DISCORD_GUILD_ID`                  | register script | yes        |                               | Your test server's ID                                                   |
| `DISCORD_BOT_TOKEN`                 | register script | yes        |                               | A real secret. Environment only; never logged or committed              |
| `DISCORD_API_BASE_URL`              | register script | no         | `https://discord.com/api/v10` | Point at a stub in tests                                                |
| `DISCORD_TIMEOUT_MS`                | register script | no         | `5000`                        |                                                                         |

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
  adapters/    implementations (Discord HTTP; pg/ holds the pool, migrator, ledger, status reader)
  http/        Express wiring, raw body on /interactions only, logging, error handler
  config.ts    the only reader of environment variables
packages/shared  zod schemas and enums used by the API and the dashboard
apps/api/migrations  numbered SQL files (001_init.sql = every DESIGN section 9 table)
scripts/         register-commands, migrate
```

## Deployment

Not yet deployed. The hosting plan and deployed URL will be added in Step 6.

## Deliverables still to come

`AI_NOTES.md` (tools, decisions, the hardest bug, next steps), a test server invite and a throwaway admin login. The running log of AI wrong turns that feeds `AI_NOTES.md` is [`docs/ai-journal.md`](docs/ai-journal.md).
