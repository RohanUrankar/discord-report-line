# Discord interactions cheat sheet

Items marked **(verify)** change over time or are easy to misremember — confirm via Context7 `/discord/discord-api-docs` before relying on them.

## Contents
1. Interaction types
2. Callback (response) types
3. Message flags
4. Minimal payloads
5. Components
6. REST endpoints used by this app
7. Bot install / admin OAuth2
8. Error codes worth special-casing

## 1. Interaction types (`interaction.type`)
| Value | Name | Notes |
|---|---|---|
| 1 | PING | Respond `{type:1}` |
| 2 | APPLICATION_COMMAND | Slash command; `data.name`, `data.options[]` |
| 3 | MESSAGE_COMPONENT | Button/select; `data.custom_id`, `data.component_type`, `message` |
| 4 | APPLICATION_COMMAND_AUTOCOMPLETE | Only if you enable autocomplete |
| 5 | MODAL_SUBMIT | `data.custom_id`, `data.components` (layout **(verify)**) |

## 2. Callback types (response `type`)
| Value | Name | Valid for |
|---|---|---|
| 1 | PONG | PING |
| 4 | CHANNEL_MESSAGE_WITH_SOURCE | command, component, modal submit |
| 5 | DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE | command, component, modal submit — shows "thinking…" |
| 6 | DEFERRED_UPDATE_MESSAGE | component, modal submit (from a component) — no visible change |
| 7 | UPDATE_MESSAGE | component — edits the message the button is on |
| 9 | MODAL | command, component — **must be the first response** |

## 3. Message flags
- `EPHEMERAL = 1 << 6 = 64` — only the invoker sees it. Use for errors and personal confirmations. For a deferred ephemeral reply, set `data.flags: 64` on the type-5 response; the follow-up inherits it.
- Components V2 uses another flag and changes allowed fields **(verify)** — don't mix with `content` without checking.

## 4. Minimal payloads
Incoming slash command (fields this app actually uses):
```json
{
  "id": "1234567890123456789",
  "application_id": "…",
  "type": 2,
  "token": "<interaction token — secret, never log>",
  "version": 1,
  "guild_id": "…",
  "channel_id": "…",
  "member": { "user": { "id": "…", "username": "…" }, "permissions": "…" },
  "data": { "id": "…", "name": "report", "type": 1,
            "options": [{ "name": "text", "type": 3, "value": "printer on fire" }] }
}
```
`member` is present in guilds; `user` (top-level) is present in DMs. Handle both or reject DMs explicitly.

Immediate reply:
```json
{ "type": 4, "data": { "content": "Logged ✅", "flags": 64, "allowed_mentions": { "parse": [] } } }
```
Deferred:
```json
{ "type": 5, "data": { "flags": 64 } }
```

Command definition (registration body item):
```json
{ "name": "report", "description": "Report an issue", "type": 1,
  "options": [{ "name": "text", "description": "What happened?", "type": 3, "required": false, "max_length": 1000 }] }
```
Option types: 3 STRING, 4 INTEGER, 5 BOOLEAN, 6 USER, 7 CHANNEL, 8 ROLE, 10 NUMBER. Names: lowercase, 1–32 chars.

## 5. Components
- Action row: `{ "type": 1, "components": [...] }` — max 5 buttons per row.
- Button: `{ "type": 2, "style": 1|2|3|4, "label": "Acknowledge", "custom_id": "ack:<id>" }`; style 5 = link (uses `url`, no `custom_id`, no interaction).
- `custom_id` ≤ 100 chars. Treat as untrusted input.
- Text input (inside modals): type 4, style 1 short / 2 paragraph, `min_length`/`max_length`/`required`. Modal wrapper/label structure **(verify)**.

## 6. REST endpoints used by this app (base `https://discord.com/api/v10` **(verify version)**)
| Purpose | Method + path | Auth |
|---|---|---|
| Edit deferred reply | PATCH `/webhooks/{app_id}/{token}/messages/@original` | none (token in path) |
| Follow-up message | POST `/webhooks/{app_id}/{token}` | none |
| Post to channel | POST `/channels/{channel_id}/messages` | `Bot <token>` |
| List guild channels (for channel picker) | GET `/guilds/{guild_id}/channels` | `Bot <token>` |
| Register guild commands | PUT `/applications/{app_id}/guilds/{guild_id}/commands` | `Bot <token>` |
| Register global commands | PUT `/applications/{app_id}/commands` | `Bot <token>` |
| Discord channel webhook (mirror) | POST `<webhook url>` | URL is the secret |

Executing a channel webhook supports `?wait=true` to get the created message back — useful to confirm delivery.

## 7. Bot install / admin OAuth2
- Install link: `https://discord.com/oauth2/authorize?client_id=<app_id>&scope=bot%20applications.commands&permissions=<int>` . Minimal permissions: View Channel, Send Messages (and Embed Links if you use embeds). Compute the integer in the Developer Portal's URL generator rather than by hand.
- To learn *which* guild was connected, add `response_type=code&redirect_uri=<your callback>&state=<csrf>`; the callback receives `guild_id` and `code` **(verify)**. Validate `state`.
- If admin login uses Discord OAuth2 (`identify` + `guilds` scopes), check the user actually has Manage Server on a guild before letting them connect it. If admin login is username/password (needed anyway for the graders' throwaway account), connecting a guild is just the install link + callback.

## 8. Error codes worth special-casing
| HTTP / Discord code | Meaning | Treat as |
|---|---|---|
| 401 on follow-up | token expired/invalid | permanent → dead |
| 404 `10015` Unknown Webhook | webhook deleted / token expired | permanent → dead |
| 403 `50001` Missing Access / `50013` Missing Permissions | bot can't see/post in channel | permanent, config error surfaced to admin |
| 429 | rate limited | retry at `retry_after` |
| 5xx / network / timeout | transient | retry with backoff |
