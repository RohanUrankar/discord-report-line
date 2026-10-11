---
name: discord-interactions
description: Correct, secure handling of Discord HTTP interactions in Node/Express/TypeScript — Ed25519 signature verification on the raw body, PING/PONG, interaction and callback types, the 3-second window with deferred responses and webhook follow-ups, buttons and modals, posting to channels with the bot token, rate limits, mention-safety, command registration, and the bot install/OAuth2 flow. Includes a lookup procedure (Context7 / official docs) so nothing is answered from stale memory. Use this whenever code touches the interactions endpoint, slash commands, components, modals, follow-up messages, the Discord REST API, the Developer Portal setup, or anything with "discord" in it — even small changes, because the pitfalls here are silent and security-relevant.
---

# Discord interactions

DESIGN.md §4 (Discord mechanics, verified by the architect) and §5 (commands and the response decision table) are the spec for this project; this skill explains the traps behind them and how to look up anything they don't cover.

The interactions endpoint is the front door that graders will attack first ("we'll also throw junk at it"). Most failures here are silent — a forged request that gets a 200, a follow-up that never arrives — so this skill front-loads the pitfalls.

## Look things up, don't remember them

Discord's API evolves (component types, modal layouts, flags). Before using any field, type number or endpoint you are not 100% sure about:

1. Context7: library `/discord/discord-api-docs` (official API docs) or `/discord/discord-interactions-js` (the helper lib).
2. Otherwise WebFetch `https://discord.com/developers/docs/...` (interactions/receiving-and-responding, interactions/message-components, interactions/application-commands, topics/rate-limits).

If you are relying on `references/api-cheatsheet.md` for something version-sensitive, it says so; verify those items. If a lookup contradicts this skill, trust the docs and log it with the `ai-journal` skill.

## The non-negotiables

1. **Verify every request on the raw bytes.** The signed message is `X-Signature-Timestamp + rawBody`. Any JSON parser that runs first changes the bytes → valid requests fail or, worse, you "fix" it by verifying `JSON.stringify(req.body)` which isn't what Discord signed. In Express, mount the interactions route with `express.raw({ type: 'application/json' })` (or a `verify` callback capturing `rawBody`) *before* any global `express.json()`.
2. **`verifyKey` from `discord-interactions` is async (returns `Promise<boolean>`).** `if (verifyKey(...))` without `await` is always truthy and accepts every forged request. Same trap with any WebCrypto-based verifier. A test that sends a bad signature and expects 401 is mandatory and catches this. Alternatively Node's built-in `crypto.verify(null, msg, publicKeyObject, sig)` with an Ed25519 SPKI key — no dependency, synchronous.
3. **Reject before you parse, record, or log.** Missing/invalid headers or bad signature → `401` with a tiny body, nothing written to the DB, one `warn` log line without the body. Discord itself sends a deliberately invalid signature when you save the endpoint URL and refuses the URL if you don't 401 it.
4. **Bound the timestamp.** Signatures don't expire, so a captured request can be replayed. Reject when `|now − timestamp| > 300s`. Dedup (below) covers replays inside the window.
5. **PING (type 1) → `{ "type": 1 }`** with status 200 and `Content-Type: application/json`, after verification. Don't record PINGs as commands.
6. **Dedup on `interaction.id`** with a database unique constraint + `INSERT … ON CONFLICT DO NOTHING RETURNING`. A check-then-insert races under concurrent duplicates. On duplicate: do no side effects; return an equivalent response (the stored one, or a neutral ephemeral ack).
7. **Respond within 3 seconds — budget ~1.5s.** If the command does anything slow (LLM, mirror webhook, channel post, anything over the network) respond with a deferral and do the work afterwards (see Flow). Cold starts eat this budget; see the `free-tier-deploy` skill.
8. **Never let user text ping people.** Echoing `/report @everyone …` into a channel pings the whole server. Set `allowed_mentions: { parse: [] }` on every message you send that contains user input.
9. **The interaction `token` is a credential** (valid ~15 min, lets anyone post as your app in that thread). Never log it or return it to the dashboard. Redact `token` in logs.

## Flow for a command that does slow work

```
POST /interactions
 ├─ verify signature + timestamp            (else 401)
 ├─ parse + validate shape                   (else 400)
 ├─ PING? → {type:1}
 ├─ BEGIN TX
 │    insert interaction (ON CONFLICT DO NOTHING) → duplicate? → COMMIT, return neutral ack
 │    evaluate rule (pure function of payload + guild config)
 │    insert outbox jobs: followup, mirror, (ai), (channel post)
 │  COMMIT
 ├─ respond: type 5 (deferred) or type 4 (immediate, if no slow work needed)
 └─ worker picks jobs → PATCH @original / POST follow-up / mirror / channel post, with retries
```

Recording and enqueueing *before* responding is what makes "don't silently lose an interaction" true: if the process dies after the response, the jobs are still in the database. See the `resilience` skill for the worker.

Follow-up endpoints use the interaction token, not the bot token:
- Edit the deferred message: `PATCH /webhooks/{application_id}/{token}/messages/@original`
- Extra message: `POST /webhooks/{application_id}/{token}`

They stop working when the token expires (~15 min). The design stores `token_expires_at` on the job; past it, the worker falls back to posting in the guild's channel with the bot token (CLAUDE.md). Fill a deferred reply with `PATCH …/@original`, not a POST follow-up.

## Buttons and modals (stretch goals)

- Component clicks arrive as type 3 and go through **the same verification and dedup** — same endpoint, same middleware. Don't add a shortcut route.
- Encode intent in `custom_id` (≤100 chars) like `ack:<reportId>`; parse defensively and authorize it — any user in the channel can click any button, and a forged `custom_id` from a modified client must not reach records in another guild.
- A modal (callback type 9) can only be the **first** response to a command or component. You cannot defer and then open a modal. So `/report` with no text → respond type 9 immediately; the submission comes back as type 5 (`MODAL_SUBMIT`) which you then defer/handle like a command.
- Modal component layout changed in 2025 (Label component, newer input types). Look up the current modal schema before writing it.

## Posting to a channel (bot token)

`POST /channels/{channel_id}/messages` with `Authorization: Bot <token>`. The bot needs View Channel + Send Messages in that channel; a 403 (`Missing Access` / `Missing Permissions`) is a configuration problem → permanent failure with a clear dashboard message ("The bot can't post in #alerts — check its channel permissions"), not a retry loop.

## Rate limits

On 429, Discord returns `retry_after` (seconds, may be fractional) in the JSON body plus `Retry-After` / `X-RateLimit-*` headers. Honour `retry_after` as the next attempt time instead of your normal backoff. Don't hammer: a global limit applies per bot and Cloudflare bans IPs that keep sending invalid requests (repeated 401/403/429s).

## Registering commands

Use a script (`scripts/register-commands.ts`), not app code, run manually with env vars:
- Guild commands (`PUT /applications/{app_id}/guilds/{guild_id}/commands`) update instantly — use for development and the test server.
- Global commands (`PUT /applications/{app_id}/commands`) for multi-server.
`PUT` replaces the whole set, so the script is idempotent and the command definitions live in one file in the repo.

## Testing locally

You cannot get Discord to sign requests for localhost, so tests sign their own: generate an Ed25519 keypair in the test setup, configure the app with the test public key, sign `timestamp + body` with the private key. `quality-bar-check/scripts/attack.mjs` contains a working signer you can mirror in a test helper.

Details on types, flags, payload shapes and the install flow: `references/api-cheatsheet.md`.
