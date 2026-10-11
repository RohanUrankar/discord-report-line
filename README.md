# The Report Line

A Discord bot that takes reports from a server, records each one exactly once, mirrors it to a team channel, and shows an admin dashboard of what happened. Built as a Node.js + TypeScript + Express API, an Angular dashboard and PostgreSQL. The design lives in [`architecture/docs/DESIGN.md`](architecture/docs/DESIGN.md); the rules every change must respect are in [`CLAUDE.md`](CLAUDE.md).

**Status: all six build steps are in.** `/report` (text or form) is recorded exactly once, deferred within 3 s, optionally tagged by Gemini, mirrored to Slack by a background worker and answered by editing the deferred reply; failed calls are retried with backoff and a dead interaction token falls back to a channel post. An admin dashboard shows every command, its action and each retry. Deployment is not done yet (see [Deployment](#deployment)).

## How it works

One Express process serves three things from one origin: the Discord interactions endpoint (`POST /interactions`), the admin JSON API (`/api`) and the Angular dashboard build. The same process runs a worker loop (it can also run alone with `WORKER_MODE=standalone`). PostgreSQL is the only datastore. Every inbound request is verified (Ed25519 over the raw body, then a 5-minute freshness check) before anything is parsed. A command is written to Postgres together with its job in one transaction, using `INSERT ... ON CONFLICT DO NOTHING` on Discord's interaction id as the dedupe key, and only then answered. The worker claims jobs with `FOR UPDATE SKIP LOCKED` and a lease, so a crash loses nothing. Domain logic is pure and sits behind ports; Discord, Slack, Gemini and Postgres are adapters. The full design, with sequence diagrams, state machines, threat model and decision records, is [`architecture/docs/DESIGN.md`](architecture/docs/DESIGN.md).

## What works today

| Request                                                                                   | Result                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing, malformed, forged or tampered signature                                          | `401`, no body, nothing stored                                                                                                                                         |
| Correct signature but a timestamp more than 5 minutes old or more than 60 s in the future | `401` (replay protection)                                                                                                                                              |
| PING (type 1)                                                                             | `200 {"type":1}`                                                                                                                                                       |
| `/status`                                                                                 | Recorded, then an inline private reply with this server's report counts                                                                                                |
| An unknown or turned-off command                                                          | Recorded, then a short private notice                                                                                                                                  |
| The same interaction delivered again                                                      | Not recorded again; answered normally                                                                                                                                  |
| The database is down or too slow                                                          | A private "we couldn't log that" notice within 3 s, never a 500                                                                                                        |
| `/report text:...`                                                                        | Recorded with its job, then "thinking..." at once; the worker mirrors to Slack and edits the reply                                                                     |
| `/report` with no text                                                                    | Opens a form (modal); nothing is stored until it is submitted                                                                                                          |
| A submitted form                                                                          | Same path as `/report text:...` (fresh interaction, deferred, worker); blank or over 1000 characters gets a private notice, nothing stored                             |
| `/report text:` blank or over 1000 characters                                             | A short private notice, nothing stored                                                                                                                                 |
| Acknowledge / Escalate on a processed report                                              | Updates the message in place (type 7) and records the click; a stale or foreign button gets a private notice. Escalate records and shows the state only: no Slack call |
| A DM                                                                                      | A short private notice (not recorded yet)                                                                                                                              |
| `GET /healthz`                                                                            | `200 {"status":"ok","db":"up","worker":"ok"}`, or `503` when the database does not answer or the worker has stopped beating                                            |

## Run it locally

Requires Node 22.12 or newer.

```bash
npm install
cp .env.example <your local env file>   # then fill in the values (see below). Never commit it.
# start a local Postgres (see "Database" below: standalone or Docker Compose)
npm run db:migrate
npm run dev
```

The server listens on `PORT` (default 3000). `npm test`, `npm run typecheck` and `npm run lint` run across both workspaces.

### Database

PostgreSQL is the only datastore (the design targets 16 or newer; 18 works). Pick one way to get a local instance, then the same three steps apply.

**Option A: a standalone instance (no Docker), Windows.** Install the PostgreSQL binaries (the EDB zip archive or installer; only `initdb`, `pg_ctl` and `createdb` are used) and run this in PowerShell, with `$PG` pointing at the `bin` folder:

```powershell
$PG = "C:\path\to\postgresql\bin"
$DATA = "$HOME\report-line-pgdata"                         # any empty folder outside the repo
Set-Content -NoNewline -Path "$HOME\pgpass.tmp" -Value "<password you choose>"
& "$PG\initdb.exe" -D $DATA -U report_line -A scram-sha-256 --pwfile="$HOME\pgpass.tmp" -E UTF8
Remove-Item "$HOME\pgpass.tmp"
& "$PG\pg_ctl.exe" -D $DATA -o "-p 5433 -c listen_addresses=127.0.0.1" -l "$HOME\report-line-pg.log" start
$env:PGPASSWORD = "<password you choose>"
& "$PG\createdb.exe" -h 127.0.0.1 -p 5433 -U report_line report_line
& "$PG\createdb.exe" -h 127.0.0.1 -p 5433 -U report_line report_line_test
```

Port 5433 is only an example of a spare port; use any free one. Stop it with `pg_ctl.exe -D $DATA stop`; start it again with the `pg_ctl ... start` line. Then set, in your local env file:
`DATABASE_URL=postgresql://report_line:<password>@127.0.0.1:5433/report_line` and
`DATABASE_URL_TEST=postgresql://report_line:<password>@127.0.0.1:5433/report_line_test`.

**Option B: Docker Compose** (Docker Desktop must be running). Set `POSTGRES_PASSWORD` in your local env file, use the same password in the URLs above (host `localhost`, port `5432`, or whatever `POSTGRES_PORT` you set), then `docker compose up -d db`. The first start also creates the `report_line_test` database.

**Option C: hosted** (for example Neon): use its pooled connection string with `?sslmode=verify-full` (the driver verifies the server certificate; never turn verification off), and a separate branch or database for `DATABASE_URL_TEST`.

Then:

1. `npm run db:migrate` applies `apps/api/migrations/*.sql` in order and records them in `schema_migrations`. It is safe to run twice, and the server never migrates on its own.
2. `npm test` needs `DATABASE_URL_TEST`; without it the database tests fail loudly instead of skipping. It must differ from `DATABASE_URL`, because the tests empty it.
3. Never paste either URL into logs, issues or commits: they contain the password.

### Environment variables

Every variable is validated at startup; a bad or missing one stops the process and names the variable (never its value). Only `.env.example` is committed.

| Variable                                          | Used by                            | Required         | Default                                            | Notes                                                                                                              |
| ------------------------------------------------- | ---------------------------------- | ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `DISCORD_PUBLIC_KEY`                              | server                             | yes              |                                                    | Developer Portal, General Information, Public Key (64 hex characters)                                              |
| `PORT`                                            | server                             | no               | `3000`                                             |                                                                                                                    |
| `LOG_LEVEL`                                       | server                             | no               | `info`                                             | `fatal` `error` `warn` `info` `debug` `trace` `silent`                                                             |
| `REPLAY_WINDOW_MS`                                | server                             | no               | `300000`                                           | Oldest `X-Signature-Timestamp` accepted                                                                            |
| `STATUS_TIMEOUT_MS`                               | server                             | no               | `1200`                                             | How long `/status` waits for its counts before replying "try again"                                                |
| `DATABASE_URL`                                    | server, migrate                    | yes              |                                                    | `postgresql://...`. A real secret: environment only, never logged                                                  |
| `DATABASE_URL_TEST`                               | tests                              | for tests        |                                                    | A separate throwaway database the tests may wipe; must differ                                                      |
| `POSTGRES_PASSWORD`                               | docker compose                     | Docker only      |                                                    | Password of the Compose container's `report_line` user                                                             |
| `RECORD_TIMEOUT_MS`                               | server                             | no               | `1000`                                             | Rule read + recording + status read must together fit the 3 s window (sum max 2800)                                |
| `RULE_TIMEOUT_MS`                                 | server                             | no               | `400`                                              | How long the rule read may take before the command is answered "not logged"                                        |
| `HEALTH_TIMEOUT_MS`                               | server                             | no               | `2000`                                             | How long `/healthz` waits for the database before answering 503                                                    |
| `DB_POOL_MAX`                                     | server                             | no               | `5`                                                | Free-tier Postgres allows few connections                                                                          |
| `DB_CONNECTION_TIMEOUT_MS`                        | server                             | no               | `1000`                                             | Waiting for a connection                                                                                           |
| `DB_STATEMENT_TIMEOUT_MS`                         | server                             | no               | `1500`                                             | Enforced by Postgres per statement                                                                                 |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`               | server                             | no               | `5000`                                             | Postgres kills a session that opens a transaction and goes quiet                                                   |
| `DISCORD_APP_ID`                                  | server, worker, register script    | yes              |                                                    | Developer Portal, General Information, Application ID                                                              |
| `DISCORD_GUILD_ID`                                | register script                    | yes              |                                                    | Your test server's ID                                                                                              |
| `DISCORD_BOT_TOKEN`                               | server, worker, register script    | yes              |                                                    | A real secret. Environment only; never logged or committed                                                         |
| `DISCORD_API_BASE_URL`                            | register script                    | no               | `https://discord.com/api/v10`                      | Point at a stub in tests                                                                                           |
| `DISCORD_TIMEOUT_MS`                              | worker, register script            | no               | `5000`                                             | Per Discord call                                                                                                   |
| `WEBHOOK_ENC_KEY`                                 | server, worker, set-mirror-webhook | yes              |                                                    | 32 random bytes, base64. A real secret                                                                             |
| `SLACK_WEBHOOK_URL_PREFIX`                        | worker, set-mirror-webhook         | no               | `https://hooks.slack.com/services/`                | Only URLs under this prefix are stored or called                                                                   |
| `SLACK_TIMEOUT_MS`                                | worker                             | no               | `5000`                                             | Per Slack call                                                                                                     |
| `LLM_ENABLED`                                     | worker                             | no               | `false`                                            | `true` tags `/report` text with Gemini (see LLM tagging). Off: no Gemini call, no key needed                       |
| `GEMINI_API_KEY`                                  | worker                             | if `LLM_ENABLED` |                                                    | A real secret. Environment only; sent in a request header                                                          |
| `GEMINI_MODEL`                                    | worker                             | no               | `gemini-3.5-flash-lite`                            | Model id (letters, digits, `.` `_` `-`)                                                                            |
| `GEMINI_TIMEOUT_MS`                               | worker                             | no               | `8000`                                             | Per Gemini call; one try, never retried                                                                            |
| `GEMINI_API_BASE_URL`                             | worker                             | no               | `https://generativelanguage.googleapis.com/v1beta` | Point at a stub in tests                                                                                           |
| `SESSION_SECRET`                                  | server                             | yes              |                                                    | 32+ random characters. A real secret: signs the per-session CSRF token                                             |
| `SESSION_TTL_MS`                                  | server                             | no               | `28800000` (8 h)                                   | Absolute session lifetime; no sliding renewal                                                                      |
| `SESSION_COOKIE_SECURE`                           | server                             | no               | `true`                                             | Set to `false` ONLY for plain-http local development. Logged as a warning at startup                               |
| `TRUST_PROXY_HOPS`                                | server                             | no               | `0`                                                | Reverse proxies in front (1 on Render), so login throttling sees real client IPs                                   |
| `WEB_DIST_DIR`                                    | server                             | no               | `apps/web/dist/web/browser`                        | Angular build served from the API origin; missing means API only                                                   |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`                   | seed-admin                         | for seeding      |                                                    | Email of the throwaway admin. Password 12+ characters: leave `ADMIN_PASSWORD` unset to be asked at a hidden prompt |
| `WORKER_MODE`                                     | process                            | no               | `inline`                                           | `standalone` runs only the worker                                                                                  |
| `CLAIM_BATCH`, `POLL_INTERVAL_MS`                 | worker                             | no               | `5`, `1000`                                        | Jobs per claim; idle poll                                                                                          |
| `LEASE_MS`                                        | worker                             | no               | `60000`                                            | Must exceed four call timeouts (tag, mirror, reply, fallback)                                                      |
| `MAX_ATTEMPTS`                                    | worker                             | no               | `8`                                                | Passes before a job is marked dead                                                                                 |
| `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`               | worker                             | no               | `500`, `60000`                                     | Full-jitter backoff                                                                                                |
| `WORKER_DB_POOL_MAX` and `WORKER_DB_*_TIMEOUT_MS` | worker                             | no               | `3`, 5000, 10000, 15000                            | The worker's own, looser database pool                                                                             |

### LLM tagging (optional)

Off by default. With `LLM_ENABLED=true` and a `GEMINI_API_KEY`, a report whose rule has `tag` on is classified by Gemini into one of `outage`, `bug`, `security`, `abuse`, `question`, `feedback`, `other`. Only the report text is sent. The answer is accepted only if it is exactly one of those words; anything else (timeout, error, odd output) stores `untagged`, records a `tag` attempt, and the report is still mirrored and answered. Tagging is tried once per report, never retried. The tag shows in the dashboard (`tagState`: tagged, untagged, pending, off) and as a trailing "tag: ..." on the Slack line. It never appears in anything posted to Discord, because the public channel fallback must not reveal what a private report is about. See DESIGN section 11.3.

### Worker, Slack mirror and fallback

The worker runs inside the server process (`WORKER_MODE=inline`, default) or alone (`WORKER_MODE=standalone`, no HTTP). It claims jobs with `FOR UPDATE SKIP LOCKED` and a lease, so several instances are safe, and a job whose worker died is picked up again once `LEASE_MS` passes. Per job it: posts the escaped report to Slack, edits the deferred reply (`PATCH @original`), and, if the interaction token is expired or Discord answers 401/404, posts in the channel with the bot token instead. A fallback for a private report never contains the report text. Timeouts, network errors, 5xx and 429 are retried (429 waits at least `Retry-After`); other 4xx are final. Every call is recorded in `job_attempt`.

The fallback goes to the server's notification channel if one is set, otherwise to the channel where the command ran.

**One-time setup for the Slack mirror** (secrets never go on a command line):

1. Generate the encryption key without printing it (PowerShell): `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); Add-Content .env ("WEBHOOK_ENC_KEY=" + [Convert]::ToBase64String($b))`
2. In Slack create an Incoming Webhook for the channel that should get reports and copy its URL.
3. Store it encrypted: copy the URL, then run `Get-Clipboard | npm run set-mirror-webhook -- <your-server-id>`. It prints only the last four characters.
4. Re-run `npm run register-commands` so `/report` exists, then run `npm run db:migrate`.

Changing `WEBHOOK_ENC_KEY` makes stored webhooks unreadable; set them again.

### Dashboard read API

All behind the sign-in cookie; every server path is checked against the servers the signed-in admin manages. A server that is not theirs, does not exist, or is not even an id all get the same `404`.

| Request                                                        | Result                                                                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/guilds`                                              | `{ items: [{ id, name }] }`: only servers this admin manages                                                                                                                             |
| `GET /api/guilds/:guildId/interactions?limit=&cursor=&status=` | `{ items, nextCursor }`, newest first. `limit` 1 to 100 (default 50); `cursor` is the previous `nextCursor` (opaque); `status` is a job status (`pending`, `processing`, `done`, `dead`) |
| `GET /api/guilds/:guildId/interactions/:id`                    | The same row plus `attemptHistory`: every outbound call the worker made                                                                                                                  |

To follow the log live, fetch the first page again every few seconds and merge by `id`: rows that were retrying turn into delivered, and new rows appear on top. Responses never include the interaction token, the webhook, or the report text.

### Dashboard write API

Every change needs the sign-in cookie AND the CSRF token in the `X-CSRF-Token` header (`401` without a session, `403` without a valid token). A change to a server the admin does not manage gets the same `404` as a server that does not exist, and writes nothing. Bad input is `400 VALIDATION_FAILED` with `error.details.fields`: field paths such as `mirrorWebhookUrl` or `config.replyMessage`, never the values.

| Request                                   | Body and result                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/guilds`                        | Connect a server the bot is already in. Body `{ guildId }`. `200 { id, name }`. First claim wins: claiming your own server again is `200`; a server another admin manages, or one the bot has never seen, is `404`                                                        |
| `GET /api/guilds/:guildId/settings`       | `{ postChannelId: string or null, mirrorConfigured: boolean }`                                                                                                                                                                                                            |
| `PUT /api/guilds/:guildId/settings`       | Body `{ postChannelId?, mirrorWebhookUrl? }`; a key left out is left alone, `null` or `""` clears it. The webhook must be an `https://hooks.slack.com/services/...` URL (see `SLACK_WEBHOOK_URL_PREFIX`). Stored encrypted, never returned. Answers the same shape as GET |
| `GET /api/guilds/:guildId/rules`          | `{ items: [{ command, enabled, customised, config }] }` for `status` and `report`; `customised: false` means the built-in default                                                                                                                                         |
| `PUT /api/guilds/:guildId/rules/:command` | Body `{ enabled, config }`, `config` shaped as in DESIGN section 8.3. Answers the saved rule. An unknown command is `400` with field `command`                                                                                                                            |

Security events (`logType: "security"`) are written for `guild.connected`, `guild.connect.denied`, `config.settings.updated`, `config.settings.rejected`, `config.rule.updated` and `config.rule.rejected`: ids and field names only, never a webhook or rule text.

Connecting is not proof of Discord ownership: anyone with a dashboard account who knows the id of an unclaimed server the bot is in can claim it (DESIGN rev 6). Fine for the single throwaway admin; production would check `MANAGE_GUILD` through Discord OAuth2. Saved rules are applied by the bot on every command (see below).

### Form, buttons and rules

- **Form.** `/report` with no `text` opens a form. Submitting it is a fresh interaction: it is validated again on the server (trimmed, 1 to 1000 characters), recorded as a `/report` and processed by the same worker path as the text option. A rejected submit stores nothing. Opening the form stores nothing either.
- **Buttons.** The processed reply carries **Acknowledge** and **Escalate**. A click is verified, deduplicated on its own id, checked against the server it came from, and answered by updating the message in place. A report moves `reported` → `acknowledged` → `escalated` (or straight to `escalated`); nothing moves back, and an out-of-date button gets a private notice. **Escalate only records and shows the state: it sends nothing to Slack or anyone else.** Any member of the server may click; with the default private reply that is only the reporter, so set `ephemeral` to `false` in the rule if a team should act on reports.
- **Rules.** Each command's rule (reply wording, private or public, Slack mirror, on or off) is read from the database on every command. A saved rule is validated strictly; a stored rule that no longer validates is logged as `rule.invalid_stored` (field names only) and the built-in default is used. A report keeps the rule it was started with, even if the rule is edited before the worker finishes. Turning `/report` off also turns off its form and its buttons.
- Needs migration `004_report_click_actions.sql` (`npm run db:migrate`).

## Connect it to Discord

Discord needs a public HTTPS URL, so while developing you expose your laptop with a tunnel.

1. **Create the app.** In the [Developer Portal](https://discord.com/developers/applications) create an application. Copy the Application ID and Public Key. On the Bot page, reset the token and copy it. Put the three values, plus your test server's ID, in your local env file.
2. **Start the server:** `npm run dev`.
3. **Start a tunnel** in a second terminal. Either works; the URL changes each run unless you set up a named tunnel.
   - Cloudflare quick tunnel (no account needed): `cloudflared tunnel --url http://localhost:3000`
   - ngrok: `ngrok http 3000`
4. **Save the URL.** In the Developer Portal, General Information, set _Interactions Endpoint URL_ to `https://<your-tunnel-host>/interactions` and save. Discord sends a signed PING plus a deliberately bad signature; the save succeeds only if the server answers the first and rejects the second.
5. **Invite the bot** with this URL (replace `<APPLICATION_ID>` with the Application ID from step 1; it is not a secret):

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=3072
   ```

   `permissions=3072` is View Channel (`1 << 10` = 1024) plus Send Messages (`1 << 11` = 2048), checked against Discord's [permissions reference](https://docs.discord.com/developers/topics/permissions). The bot needs no more: it replies through interaction tokens and, only for the channel fallback, posts one message. Do this before registering: Discord refuses to register guild commands for a server the app is not in. `applications.commands` is included with `bot` automatically; it is spelled out so the URL matches what the portal's generator produces.

6. **Register the commands:** `npm run register-commands`. It replaces the server's whole command set in one call (`PUT /applications/{app}/guilds/{guild}/commands`), so it is safe to repeat, and guild commands appear instantly. It registers `/status` and `/report` (an optional `text` option, 1 to 1000 characters; without it the bot opens a form). It needs `DISCORD_APP_ID`, `DISCORD_GUILD_ID` and `DISCORD_BOT_TOKEN`, and optionally `DISCORD_API_BASE_URL` and `DISCORD_TIMEOUT_MS`. On failure it prints the HTTP status, Discord's error code and message, and what to try (for example "invite the bot with the applications.commands scope"). It never prints the token. Then run `/status` in the server.

### Dashboard sign-in and the admin account

The dashboard has one seeded throwaway admin; there is no sign-up. Create it, or reset its password, against the database the server uses:

1. Put `DATABASE_URL` in your local env file (or set it in the shell). Leave `ADMIN_PASSWORD` unset.
2. PowerShell: `$env:ADMIN_EMAIL = "admin@example.test"` (any email), then `npm run seed-admin`.
3. At the hidden prompt type a password of 12 or more characters, then repeat it. Nothing is echoed, printed or written to a file. (Alternatively set `ADMIN_PASSWORD` in the environment for a non-interactive run; do not commit it.)
4. Running it again with the same email resets the password and ends that admin's sessions.
5. Open the dashboard at the server's own URL, sign in, and use _Connect a server_ with your test server's ID (the bot must already be in it).

No credential is stored in this repository. The admin email and password for the demo are handed over separately. [ROHAN: supply the test-server invite and the admin login to the graders in the submission message]

**Sign-in rules (as implemented).** Passwords are hashed with argon2id. The session is an opaque id in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie (`__Host-session`), stored hashed in the database, 8 hours absolute. Every change needs a CSRF token. **Login throttle:** at most **5 attempts per IP and email per 60 seconds**, and **20 per IP per 60 seconds** (fixed windows, kept in memory so a restart clears them). Every attempt counts, successful or not, and an attempt that is refused still counts, so a client that keeps trying stays blocked until its window ends. Over the limit the answer is `429` with `Retry-After`. Behind a reverse proxy set `TRUST_PROXY_HOPS` (1 on Render), otherwise all admins share the proxy's address; the server logs `config.proxy_not_trusted` once if it sees a forwarded header while that is 0.

### Serving the dashboard

The server also serves the Angular build, so the dashboard and the API share one origin (the session cookie is `SameSite=Lax`, so a separate static host would break sign-in; there is no CORS). Build it with `npm run build` and start the server: it serves the files in `WEB_DIST_DIR`, and any other `GET` that is not `/api`, `/interactions`, `/healthz` or a file gets `index.html`, so Angular routes survive a reload. Unknown `/api` routes answer a JSON `404`, never the page. Hashed bundles are cached for a year; `index.html` is revalidated every time. Without a build the server logs `web.dist_missing` and runs as an API only.

Every response carries `Content-Security-Policy` (`script-src 'self'`, `style-src 'self' 'unsafe-inline'` for Angular Material, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Strict-Transport-Security`.

The live log is a **poll**: the dashboard asks for the newest rows every 5 seconds (backing off to 10 s, then 30 s, after errors) and merges by id, so a retrying row turns into delivered on screen without a reload. Server-sent events were not built; see Known limitations.

### Health check

`GET /healthz` needs no sign-in and returns only `{ "status", "db", "worker" }`. It runs one primary-key query bounded by `HEALTH_TIMEOUT_MS` and checks the worker's heartbeat. `200` means the database answered and the worker beat within the last `LEASE_MS`, or the process is still in its first lease after boot. Otherwise `503` (`db: "down"`, or `worker: "stale"`). The answer is reused for 5 seconds. This is the URL to give a host health check and a keep-warm pinger; a ping also wakes a suspended hosted database.

### Tests

```bash
npm test            # both workspaces; needs DATABASE_URL_TEST (a throwaway database), see Database
npm run typecheck
npm run lint
```

Tests sign their own requests with a generated Ed25519 keypair and talk to local stub servers standing in for Discord, Slack and Gemini; nothing reaches a real service. The database tests run against a real PostgreSQL because the unique-constraint behaviour is what is being proved. `apps/web` has its own Vitest and axe-core suite (`npm test -w @report-line/web`).

## Known limitations

- **Slack is at-most-once-ish, not exactly-once.** Slack webhooks have no idempotency key. If Slack accepts a post but the response is lost, or the process dies between Slack's answer and the `mirror_status = 'sent'` marker, the retry posts again. A crash test produced two posts for one report. The deferred reply is still edited once. (DESIGN section 14.)
- **First claim wins (design rev 6).** Connecting a server is not proof of Discord ownership: anyone with a dashboard account who knows the ID of an unclaimed server the bot is in can claim it, and the first claimant keeps it. Fine for one throwaway admin; production should verify `MANAGE_GUILD` through Discord OAuth2. (ADR-0003 consequences.)
- **Polling, not SSE.** The live log refreshes every 5 seconds; there are no server-sent events. SSE was an optional toggle (F-13) and many free hosts buffer or cut long-lived streams, so polling is the dependable choice here. It is fully working and tested.
- **The deferred reply waits for the mirror and the tag.** With Slack down the reply stays on "thinking..." through the retry period (up to the 15-minute token life); with Gemini slow it waits up to `GEMINI_TIMEOUT_MS` extra.
- **Login throttle is per process.** The counters are in memory (no second datastore by design), so a restart clears them and two instances would each count.
- **Gemini has not been called live in development.** Only stubs were used; do one tagged `/report` with a real key before relying on it.

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
scripts/         register-commands, migrate, set-mirror-webhook
```

## Deployment

**Status: not deployed. The host is not decided; this section is a proposal for a Render-style host, to be confirmed or replaced.** [ROHAN: choose the host and fill in the deployed URL here]

Proposed shape (one web service, one database, nothing else):

| Piece             | Proposal                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web service       | Node 22, one instance. Render free web services sleep after 15 minutes idle and take 30 to 60 s to wake, which breaks the 3 s window for the first command, so use an external pinger (below) or a plan that does not sleep.                                                                                                                |
| Build command     | `npm ci --include=dev && npm run build` (the install must include dev dependencies: the Angular build and `tsx` are there)                                                                                                                                                                                                                  |
| Start command     | `npm run db:migrate && npm start` (migrations are idempotent and take an advisory lock; the free tier has no pre-deploy hook)                                                                                                                                                                                                               |
| Health check path | `/healthz`                                                                                                                                                                                                                                                                                                                                  |
| Database          | A hosted PostgreSQL (for example Neon), pooled connection string with `?sslmode=verify-full`.                                                                                                                                                                                                                                               |
| Environment       | Everything in the table above marked required, set in the host's secret store: `DISCORD_PUBLIC_KEY`, `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN`, `DATABASE_URL`, `WEBHOOK_ENC_KEY`, `SESSION_SECRET`; plus `TRUST_PROXY_HOPS=1`. Optional: `LLM_ENABLED=true` and `GEMINI_API_KEY`. Leave `SESSION_COOKIE_SECURE` unset (it defaults to `true`). |
| Keep-warm         | A free pinger (cron-job.org or a scheduled GitHub Action) calling `GET https://<host>/healthz` every 10 minutes.                                                                                                                                                                                                                            |

After the first deploy, from your own machine (secrets in your shell or local env file, never in the repo):

1. In the Developer Portal set _Interactions Endpoint URL_ to `https://<host>/interactions` and save (Discord sends a signed PING and a bad-signature probe; saving succeeds only if both are handled).
2. Invite the bot with the URL under [Connect it to Discord](#connect-it-to-discord), then `npm run register-commands` (guild commands, safe to repeat).
3. `npm run seed-admin` with `DATABASE_URL` pointing at the hosted database (see [Dashboard sign-in](#dashboard-sign-in-and-the-admin-account)).
4. Sign in on the deployed URL, connect the test server, and store the Slack webhook with `npm run set-mirror-webhook -- <server-id>`.
5. Run `/status` and `/report text:hello` in the server and check the dashboard log.

Before every deploy: `npm audit --omit=dev --audit-level=high`, `npm test`, and a grep of the built `apps/web/dist` for token shapes.

## Deliverables

- This README and [`.env.example`](.env.example) (placeholders only).
- [`AI_NOTES.md`](AI_NOTES.md): tools and models used, decisions, hard bugs, what to add next. The running log of AI wrong turns behind it is [`docs/ai-journal.md`](docs/ai-journal.md).
- [`CLAUDE.md`](CLAUDE.md): the AI context file (invariants), with [`docs/agent-workflow.md`](docs/agent-workflow.md) and the `.claude/` agents, skills and hooks.
- Test-server invite URL (above) and a throwaway admin login. [ROHAN: supply with the submission]
