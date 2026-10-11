import { z } from 'zod';

import { Snowflake } from './dashboard.js';
import { ReportRuleConfig, StatusRuleConfig } from './rules.js';

// Write API of the dashboard (DESIGN §2.3, rev 6): connect a server, set where its reports go, edit its
// command rules. Responses are explicit allow-lists, like the read API: the mirror webhook URL is a secret
// that goes in and never comes back, so a settings response says only whether one is configured.

/** A Slack incoming-webhook URL is about 80 characters; this only bounds what the API will read. */
export const WEBHOOK_URL_MAX_LENGTH = 500;

/** `POST /api/guilds`: claim a server the bot is already in. */
export const ConnectGuildRequest = z.object({ guildId: Snowflake }).strict();
export type ConnectGuildRequest = z.infer<typeof ConnectGuildRequest>;

/** `GET` and `PUT /api/guilds/:guildId/settings`. No webhook URL, no ciphertext, no last characters. */
export const GuildSettings = z
  .object({
    /** Where the bot posts when the original reply can no longer be edited; null until set. */
    postChannelId: Snowflake.nullable(),
    mirrorConfigured: z.boolean(),
  })
  .strict();
export type GuildSettings = z.infer<typeof GuildSettings>;

/**
 * `PUT /api/guilds/:guildId/settings`. A key left out is left alone. `null` or an empty string clears the
 * value on purpose, so an admin who empties the form field really removes it.
 */
export const UpdateGuildSettingsRequest = z
  .object({
    postChannelId: z.union([Snowflake, z.literal(''), z.null()]).optional(),
    mirrorWebhookUrl: z.string().trim().max(WEBHOOK_URL_MAX_LENGTH).nullable().optional(),
  })
  .strict()
  .refine((body) => body.postChannelId !== undefined || body.mirrorWebhookUrl !== undefined, {
    error: 'Send at least one setting to change.',
  });
export type UpdateGuildSettingsRequest = z.infer<typeof UpdateGuildSettingsRequest>;

const RuleFlags = { enabled: z.boolean(), customised: z.boolean() };

/**
 * One command's rule as the dashboard edits it. `customised` is false when the server has no saved rule (or
 * the saved one is unusable) and `config` is the built-in default.
 */
export const RuleView = z.discriminatedUnion('command', [
  z.object({ command: z.literal('status'), ...RuleFlags, config: StatusRuleConfig }).strict(),
  z.object({ command: z.literal('report'), ...RuleFlags, config: ReportRuleConfig }).strict(),
]);
export type RuleView = z.infer<typeof RuleView>;

export const RuleList = z.object({ items: z.array(RuleView) }).strict();
export type RuleList = z.infer<typeof RuleList>;

/**
 * `PUT /api/guilds/:guildId/rules/:command`. `config` is checked against that command's schema in
 * RULE_SCHEMAS by the server; a problem is reported as `config.<field>`.
 */
export const UpdateRuleRequest = z.object({ enabled: z.boolean(), config: z.unknown() }).strict();
export type UpdateRuleRequest = z.infer<typeof UpdateRuleRequest>;
