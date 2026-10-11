# 0002 — Define the command-rule schema, the Action type and the domain status enums

**Status:** Accepted with amendments, 2026-10-11 (DESIGN rev 2: §8.3, §9, §11.2, §11.3)
**Amendments:** (1) Rule config is per command (`StatusRuleConfig = {version, ephemeral}`, `ReportRuleConfig = {version, ephemeral, replyMessage, mirror, tag}`), because the single shape forced `/status` to break its own `replyMessage` 1–300 rule. (2) `validateRule(command, json)` takes the command; `evaluate` accepts the raw stored JSON and validates internally. (3) The `ACTION` row is inserted in the outbox transaction so the worker only updates markers. (4) `JOB_ATTEMPT.target` added (`tag | mirror | followup | fallback`). (5) LLM tagging is one try per pass, never retried, so it cannot block the mirror. Router types and DM → `unsupported` accepted as proposed.
**Raised by:** backend-implementer, while implementing `apps/api/src/domain/rules.ts` and `types.ts`
**Blocks:** `domain/rules.ts`, `domain/types.ts`, `domain/reply.ts` (reply content depends on the rule), the `packages/shared` rule schema the frontend rule editor builds against (Step 4/5)

## Context

DESIGN refers to rules everywhere but never defines them:

- §7: `rules.ts # RuleEngine: evaluate(command, ctx, rule): Action ; validateRule(json)`, and `types.ts # Interaction, Action, Rule, Job, enums`.
- §9: `COMMAND_RULE.config jsonb`, `ACTION.type text`, `ACTION.mirror_status text`, `INTERACTION.status text`, `JOB.kind text`, `JOB_ATTEMPT.outcome text`.
- §16 Step 5: "rules-as-data with schema validation and safe fallback"; "WHEN a saved rule is malformed THE SYSTEM SHALL reject it on save; WHEN a stored rule is invalid at runtime THE SYSTEM SHALL fall back to a default".
- F-04 "applies a rule and responds", F-07 "Admin configures command behaviour in the UI".

The following are not specified anywhere:
1. The `config` JSON schema, meaning what an admin can actually configure.
2. The `ctx` argument of `evaluate`.
3. The `Action` type and the allowed `ACTION.type` values.
4. The default rule used when no row exists or the stored row is invalid.
5. The allowed values of `INTERACTION.status`, `JOB.kind`, `JOB_ATTEMPT.outcome` and `ACTION.mirror_status`. `JOB.status` can be inferred from §11.1 as `pending | processing | done | dead`. The skill's suggestion of several jobs per interaction ("followup, mirror, (ai), (channel post)") conflicts with §9's **unique** `job.interaction_id`, so `kind` cannot be inferred either.

The rule schema is shared with the frontend rule editor, which builds in parallel. Choosing it alone would set a contract nobody approved, and the status enums become DB check constraints.

## Proposal (minimal, sized to F-04/F-05/F-07)

**Rule config** (zod, `.strict()`, lives in `packages/shared`; `enabled` stays its own column):

```ts
CommandRuleConfig = {
  version: 1,
  ephemeral: boolean,          // reply visibility; decided at defer time (§4: the only flag allowed on type 5)
  replyMessage: string,        // 1..300 chars, shown when the work completes; plain text, no placeholders in v1
  mirror: boolean,             // send the Slack notification (F-05)
  tag: boolean,                // ask the LLM for a tag; no effect unless LLM_ENABLED (F-12)
}
```

Defaults when no row exists, or when the stored row fails validation at runtime:
- `/report`: `{ ephemeral: true, replyMessage: "Report logged. The team has been notified.", mirror: true, tag: false }`
- `/status`: `{ ephemeral: true, replyMessage: "", mirror: false, tag: false }` (reply text comes from the status counts)

**`evaluate(command: string, ctx: { enabled: boolean }, rule: CommandRuleConfig | null): Action`**, where `rule = null` means "use the default":

```ts
type Action =
  | { type: 'disabled' }                                         // enabled = false → ephemeral "This command is turned off on this server."
  | { type: 'status'; ephemeral: boolean }                       // type 4 reply
  | { type: 'report'; ephemeral: boolean; replyMessage: string; mirror: boolean; tag: boolean } // type 5 + job
  | { type: 'unknown_command' };                                  // ephemeral "I don't know that command."
```

`ACTION.type` stores `Action['type']` plus the button actions `'acknowledged' | 'escalated'` (§5.3).

**`validateRule(json: unknown)`** returns `{ ok: true; rule } | { ok: false; fields: string[] }`. It never throws, and it reports field names but never values.

**Enums** (`as const` objects in `domain/types.ts`, mirrored as DB check constraints):
- `JobStatus`: `pending | processing | done | dead` (§11.1)
- `JobKind`: `report | component`. There is one job per interaction, as §9 says, and that one job does tag, then mirror, then follow-up in sequence.
- `AttemptOutcome`: `success | retryable | fatal`
- `InteractionStatus` (from §11.2, PINGs are never stored): `answered | deferred | followed_up | fallback_posted | failed`
- `MirrorStatus`: `pending | sent | failed | skipped`

**Small router types**, recorded here so the frontend and app layers see them. Tell me if you disagree with any of these:
- `Actor = { userId }`, `Tenant = { guildId, channelId }`, `MessageRef = { messageId }`.
- A DM interaction (no `guild_id`) classifies as `{ kind: 'unsupported' }`, since every command is guild-scoped.
- Modal submit `fields` are read from both the new Label layout (type 18 wrapping text input type 4) and the deprecated Action Row layout (type 1). The modal we *send* uses Label + text input (type 18 + 4), per https://discord.com/developers/docs/components/reference#label ("Action Row with Text Inputs in modals are now deprecated").

## Options considered

- **A. The minimal schema above (recommended).** It covers every F-xx that mentions rules, gives the UI four controls, and has an obvious safe default.
- **B. A generic condition/action rules engine** (match on text or keywords, then an action list). More impressive, but it is a larger untested surface, a much harder editor for the frontend, and nothing in the brief needs it.
- **C. No config, just enable/disable.** Too thin to demonstrate F-07 ("configures command behaviour").

## Consequences

- DESIGN §9 gains check constraints for the enums, and §8.1 gains the `evaluate`/`validateRule` signatures and the `Action` union.
- `packages/shared` hosts `CommandRuleConfig`. The frontend's rule editor binds to its four fields.
- A one-job-per-interaction worker runs tag, mirror and follow-up as sequential steps. A retry after a successful mirror must not repost, so the job needs a "mirrored" marker. §14 already requires that ("record a 'mirrored' marker"), but §9 has no column for it. Proposed: use `ACTION.mirror_status = 'sent'` as that marker.
