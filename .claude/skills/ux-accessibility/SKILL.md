---
name: ux-accessibility
description: UX, information design and WCAG 2.2 AA accessibility rules for the admin dashboard — task-first navigation, the live command log and event timeline, failures/retry visibility, connect-server and command-config flows, loading/empty/error/partial states, keyboard and screen-reader support, focus management, contrast, responsive layout and motion. Use this whenever you design or build a screen, table, form, dialog, notification, or flow in the dashboard, review a UI for usability or accessibility, or decide how to present statuses, errors, live updates or long lists.
---

# UX & accessibility

The admin opens the dashboard for three reasons. Design every screen around them, in this order:

1. **"Is it working?"** — recent commands, what the bot did, anything failing. (Default landing view.)
2. **"Set it up"** — connect a Discord server, pick the post channel, set the notification channel.
3. **"Change how it behaves"** — configure command rules.

Graders will do exactly this in a few minutes. If they can run `/report` in Discord and *see it appear* on the dashboard with its actions without reloading or hunting, the product feels real.

## Screen states — every data view has all four

| State | What to show |
|---|---|
| Loading | Skeleton rows matching the final layout (no layout jump); spinner only for < 1 row areas. |
| Empty | Why it's empty + the next action ("No commands yet. Run `/status` in your server." with a copy button). |
| Error | What failed + Retry button + request ref; keep previously loaded data visible if any (partial state). |
| Loaded | The data; with a subtle "updated 5s ago" / live indicator for the log. |

## Live command log

- Table columns, in priority order: time, server/channel, user, command + text (truncated), outcome status, actions summary (chips: Replied ✓, Mirrored ⏳, AI tag). Row expands to the **event timeline** (received → deferred → follow-up → mirror attempt 1 failed 503 → attempt 2 ok).
- New rows arriving **must not move what the admin is reading**: if they're scrolled down or a row is expanded, show a "3 new — show" pill instead of inserting at top. At top and idle, insert with a brief highlight.
- Statuses = icon + word + color (`✓ Delivered`, `↻ Retrying 2/8`, `✕ Failed: webhook deleted`) — never color alone (WCAG 1.4.1).
- Filters (command, status, server) live in the URL query string so refresh/back/share work.
- A separate **Failures** view (or a pinned banner "2 notifications failed — view") so problems surface without scrolling.

## Flows

- **Connect server**: a stepper — 1) Add bot to server (opens Discord install link) → 2) Back here: server detected ✓ → 3) Pick post channel (only channels the bot can post in; explain if the list is empty) → 4) Notification channel (paste webhook URL, "Send test message" button with clear result) → Done, with "Try `/status` in Discord now".
- **Command config**: one card per command: enabled toggle, rule fields, reply template preview, ephemeral/public choice. Save per card; show dirty state; warn on navigating away with unsaved changes. Validation inline on blur and on submit; on submit errors, focus the first invalid field.
- **Destructive actions** (disconnect server, delete rule) use a confirm dialog that names the consequence; the confirm button repeats the verb ("Disconnect").
- Secrets (webhook URL) are write-only: show "Configured · ends in abcd" + Replace, never the full value.

## Accessibility (WCAG 2.2 AA)

- **Keyboard**: everything reachable and operable by keyboard in a logical order; visible focus (Material strong focus indicators); no keyboard traps; Esc closes dialogs; expandable rows toggle with Enter/Space and expose `aria-expanded`.
- **Focus management**: on route change move focus to the page `<h1>`; on dialog open focus the first field, on close return focus to the trigger (Material dialog does this — don't break it); after a save error focus the error summary or first invalid field.
- **Screen readers**: semantic HTML first (`<main>`, `<nav>`, `<h1>`–`<h3>` in order, `<table>` via `mat-table` with header cells); icon-only buttons have `aria-label`; form fields have visible labels (not placeholder-only); errors linked via `mat-error`.
- **Live regions**: announce *summaries*, not every row — e.g. `aria-live="polite"` region saying "3 new commands". Snackbars are announced by Material's `LiveAnnouncer`; don't double-announce.
- **Contrast**: text ≥ 4.5:1, large text and UI components ≥ 3:1, in both light and dark themes. Check status chip colors specifically.
- **Target size**: interactive targets ≥ 24×24 CSS px (2.2 SC 2.5.8); prefer Material defaults.
- **Motion**: respect `prefers-reduced-motion` (no row-highlight animation, no animated skeleton shimmer).
- **Zoom/reflow**: usable at 200% zoom and 320px width — the table collapses to stacked cards on narrow screens rather than horizontal scrolling the whole page.

## Visual hierarchy

- One primary action per view. Page title + one-line description of what the page is for.
- Dense but breathable: Material density −1 for tables is fine; don't go below.
- Times relative with absolute on hover/`title`; user text in a monospace-free, truncated cell with full text in the expanded row.
- Copy follows the `user-facing-messages` skill.

## Quick self-check before reporting a screen done

Tab through it without a mouse · zoom to 200% · toggle dark mode · kill the API and reload (error state) · empty DB (empty state) · throttle network (loading state) · run the Angular/axe a11y checks if configured.
