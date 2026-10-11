import { z } from 'zod';

import type { Actor, MessageRef, Tenant } from './types.js';

/** Inbound interaction types (DESIGN §4). We handle 1, 2, 3 and 5. */
export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

/** Component types needed to read a modal submission (verified: docs components/reference). */
const COMPONENT_TYPE = { ACTION_ROW: 1, TEXT_INPUT: 4, LABEL: 18 } as const;

const MAX_CUSTOM_ID = 100; // Discord limit on custom_id
const MAX_TEXT_INPUT_VALUE = 4000; // Discord limit on a text input value
const MAX_COMMAND_NAME = 32;
const MAX_OPTIONS = 25;
const MAX_MODAL_ROWS = 25;

const Snowflake = z.string().regex(/^\d{17,20}$/);
const UserRef = z.object({ id: Snowflake });

/**
 * The fields of a Discord interaction this app reads. Unknown fields are stripped, not rejected, because
 * Discord adds fields over time. Parse only AFTER the signature has been verified (CLAUDE.md).
 */
const RawInteractionSchema = z.object({
  id: Snowflake,
  type: z.number().int(),
  application_id: z.string().max(32).optional(),
  token: z.string().min(1).max(1000).optional(),
  guild_id: Snowflake.optional(),
  channel_id: Snowflake.optional(),
  channel: z.object({ id: Snowflake }).optional(),
  member: z.object({ user: UserRef }).optional(),
  user: UserRef.optional(),
  message: z.object({ id: Snowflake }).optional(),
  data: z.unknown().optional(),
});
export type RawInteraction = z.infer<typeof RawInteractionSchema>;

const CommandData = z.object({
  name: z.string().min(1).max(MAX_COMMAND_NAME),
  options: z
    .array(
      z.object({ name: z.string().min(1).max(MAX_COMMAND_NAME), value: z.unknown().optional() }),
    )
    .max(MAX_OPTIONS)
    .optional(),
});

const ComponentData = z.object({ custom_id: z.string().min(1).max(MAX_CUSTOM_ID) });

const ModalData = z.object({
  custom_id: z.string().min(1).max(MAX_CUSTOM_ID),
  components: z
    .array(
      z.object({
        type: z.number().int(),
        component: z.unknown().optional(),
        components: z.array(z.unknown()).max(MAX_MODAL_ROWS).optional(),
      }),
    )
    .max(MAX_MODAL_ROWS),
});

const TextInputValue = z.object({
  type: z.literal(COMPONENT_TYPE.TEXT_INPUT),
  custom_id: z.string().min(1).max(MAX_CUSTOM_ID),
  value: z.string().max(MAX_TEXT_INPUT_VALUE),
});

export type RouteDecision =
  | { kind: 'ping' }
  | {
      kind: 'command';
      name: string;
      options: Record<string, unknown>;
      actor: Actor;
      tenant: Tenant;
    }
  | { kind: 'component'; customId: string; actor: Actor; tenant: Tenant; message: MessageRef }
  | {
      kind: 'modalSubmit';
      customId: string;
      fields: Record<string, string>;
      actor: Actor;
      tenant: Tenant;
    }
  | { kind: 'unsupported' };

const UNSUPPORTED: RouteDecision = { kind: 'unsupported' };

/** Validates the shape of a verified, JSON-parsed body. Returns undefined when it is not an interaction. */
export function parseInteraction(json: unknown): RawInteraction | undefined {
  const result = RawInteractionSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/**
 * Routes a verified interaction (DESIGN §8.1, §5.4). A PING is answered from its type alone: nothing else
 * is read from it. Every other kind needs a guild, so a DM (no guild_id) is unsupported.
 */
export function classify(interaction: RawInteraction): RouteDecision {
  if (interaction.type === INTERACTION_TYPE.PING) {
    return { kind: 'ping' };
  }
  const origin = originOf(interaction);
  if (!origin) {
    return UNSUPPORTED;
  }
  switch (interaction.type) {
    case INTERACTION_TYPE.APPLICATION_COMMAND:
      return classifyCommand(interaction.data, origin);
    case INTERACTION_TYPE.MESSAGE_COMPONENT:
      return classifyComponent(interaction, origin);
    case INTERACTION_TYPE.MODAL_SUBMIT:
      return classifyModalSubmit(interaction.data, origin);
    default:
      return UNSUPPORTED;
  }
}

interface Origin {
  actor: Actor;
  tenant: Tenant;
}

function originOf(interaction: RawInteraction): Origin | undefined {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  const userId = interaction.member?.user.id;
  if (guildId === undefined || channelId === undefined || userId === undefined) {
    return undefined;
  }
  return { actor: { userId }, tenant: { guildId, channelId } };
}

function classifyCommand(data: unknown, origin: Origin): RouteDecision {
  const parsed = CommandData.safeParse(data);
  if (!parsed.success) {
    return UNSUPPORTED;
  }
  const options = Object.fromEntries(
    (parsed.data.options ?? [])
      .filter((option) => option.value !== undefined)
      .map((option) => [option.name, option.value]),
  );
  return { kind: 'command', name: parsed.data.name, options, ...origin };
}

function classifyComponent(interaction: RawInteraction, origin: Origin): RouteDecision {
  const parsed = ComponentData.safeParse(interaction.data);
  if (!parsed.success || interaction.message === undefined) {
    return UNSUPPORTED;
  }
  return {
    kind: 'component',
    customId: parsed.data.custom_id,
    message: { messageId: interaction.message.id },
    ...origin,
  };
}

function classifyModalSubmit(data: unknown, origin: Origin): RouteDecision {
  const parsed = ModalData.safeParse(data);
  if (!parsed.success) {
    return UNSUPPORTED;
  }
  return {
    kind: 'modalSubmit',
    customId: parsed.data.custom_id,
    fields: Object.fromEntries(parsed.data.components.flatMap(textInputsOf)),
    ...origin,
  };
}

/**
 * Text inputs from one top-level modal component: the current Label layout (18 wrapping one component)
 * or the deprecated Action Row layout (1 wrapping a list). Anything else (e.g. selects) is ignored.
 */
function textInputsOf(row: ModalRow): [string, string][] {
  const entries: [string, string][] = [];
  for (const child of childrenOf(row)) {
    const input = TextInputValue.safeParse(child);
    if (input.success) {
      entries.push([input.data.custom_id, input.data.value]);
    }
  }
  return entries;
}

type ModalRow = z.infer<typeof ModalData>['components'][number];

function childrenOf(row: ModalRow): unknown[] {
  if (row.type === COMPONENT_TYPE.LABEL) {
    return [row.component];
  }
  if (row.type === COMPONENT_TYPE.ACTION_ROW) {
    return row.components ?? [];
  }
  return [];
}
