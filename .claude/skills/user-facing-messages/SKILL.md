---
name: user-facing-messages
description: Voice, structure and wording rules for every message a human sees — Discord bot replies (ephemeral and public), mirror notifications in Slack/Discord, dashboard toasts/snackbars, form validation errors, empty states, and API error messages — plus a single error-code-to-message map shared by backend and frontend. Use this whenever you write text a user or admin will read: bot responses, error messages, button labels, empty/loading/error states, confirmation dialogs, notifications, or when mapping an error code to a message. Also use when reviewing copy that sounds technical, vague, or blames the user.
---

# User-facing messages

Two audiences read this app's text: **Discord users** running commands (non-technical, mid-conversation, want to know "did it work?") and the **admin** on the dashboard (somewhat technical, wants to know "what happened and what do I do?"). Both should never see stack traces, HTTP codes, or internal jargon.

## The formula

**What happened + what happens next / what to do.** One or two short sentences.

| ❌ | ✅ |
|---|---|
| `Error 500: ECONNREFUSED` | We couldn't log that right now. Please try again in a minute. |
| `Invalid input` | Your report needs some text — try `/report printer is jammed`. |
| `Success` | Report logged ✅ We've let the team know in #ops-alerts. |
| `Mirror failed` | Logged ✅ The Slack notification is delayed — we'll keep retrying. |
| `Unauthorized` | Your session ended. Sign in again to continue. |

## Be honest about async work

Most work runs after the response. Don't claim something finished when it's only queued: "posting to #alerts shortly" not "posted to #alerts". When the follow-up edits the deferred message, it can then say what actually happened.

## Discord replies

- **Ephemeral** (only the invoker sees) for: errors, validation problems, personal confirmations, anything with config details. **Public** for content meant for the channel.
- Keep under ~300 chars; Discord hard limit is 2000. Use one emoji as a status marker at most (✅ ⏳ ⚠️), not decoration.
- Use the user's own words when echoing ("Logged: “printer is on fire”"), truncated to ~100 chars, with mentions disabled (see `discord-interactions`).
- Tell users the command syntax when they misuse it — they can't see docs mid-chat.
- Never include internal ids except a short reference when something failed: "Something went wrong on our side (ref `7f3a`)."

## Mirror notifications (Slack / second channel)

Written for the team reading the channel later: lead with the what, then who/where, then the AI tag if any.
`🆕 Report from @alice in #general — “printer is on fire” · triage: hardware / high`

## Dashboard

- **Toasts/snackbars** for outcomes of the admin's own actions ("Settings saved", "Couldn't save — the webhook URL was rejected by Slack"). Errors stay until dismissed or include an action (Retry); successes auto-dismiss after ~4s.
- **Inline field errors** for validation, phrased as how to fix: "Enter a URL starting with https://".
- **Empty states** explain why it's empty and the next step: "No commands yet. Run `/status` in your Discord server and it will appear here."
- **Status labels** are words plus icon plus color, never color alone: `Delivered`, `Retrying (3/8)`, `Failed — webhook deleted`.
- **Confirmations** name the consequence: "Disconnect *My Server*? The bot will stop responding there. Logs are kept."
- Times: relative ("2 min ago") with absolute on hover.

## One map, two consumers

Keep stable error codes and their default messages in one place (e.g. `packages/shared/src/messages.ts`):

```ts
export const errorMessages = {
  VALIDATION_FAILED: 'Some fields need attention.',
  SESSION_EXPIRED: 'Your session ended. Sign in again to continue.',
  MIRROR_WEBHOOK_INVALID: 'That webhook URL was rejected. Check it and paste it again.',
  DISCORD_MISSING_PERMISSIONS: "The bot can't post in that channel. Give it View Channel and Send Messages.",
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
} as const satisfies Record<string, string>;
```

The backend uses it for `error.message` in API responses and Discord replies; the frontend falls back to it when a response has no message, and switches on `code` for special handling (e.g. `SESSION_EXPIRED` → redirect to login). Add new codes here first.

## Tone

Plain, calm, specific, second person, active voice. No blame ("you entered an invalid…" → "That URL doesn't look right"). No exclamation marks on errors. No "Oops!". Consistent words: pick "server" (not guild) for users, "command" (not interaction), "notification channel" (not mirror) in UI copy — internal code can keep Discord's terms.
