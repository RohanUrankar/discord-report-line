// Discord wire contract: numeric types, limits and JSON shapes. Changes only when Discord does.
// Numeric types verified against docs.discord.com (interactions/receiving-and-responding,
// components/reference).

/** Interaction callback (response) types (DESIGN §4). */
export const CALLBACK_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, TEXT_INPUT: 4, LABEL: 18 } as const;
export const BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 } as const;
export const TEXT_INPUT_STYLE = { SHORT: 1, PARAGRAPH: 2 } as const;

/** `1 << 6`. On a type 5 defer it is the only flag allowed, so visibility is fixed at defer time. */
export const EPHEMERAL_FLAG = 64;

/** Discord message content limit. */
export const MAX_CONTENT_LENGTH = 2000;

// Discord limits, verified on docs.discord.com (URLs in reportModal.test.ts).
export const DISCORD_LIMITS = {
  modalTitle: 45, // interactions/receiving-and-responding: Modal "title … max 45 characters"
  labelText: 45, // components/reference: Label "label … max 45 characters"
  labelDescription: 100, // components/reference: Label "description … max 100 characters"
  textInputPlaceholder: 100, // components/reference: Text Input "placeholder … max 100 characters"
  textInputMaxLength: 4000, // components/reference: Text Input "max_length … min 1, max 4000"
  customId: 100, // components/reference: custom_id "1-100 characters"
} as const;

const SNOWFLAKE = /^\d{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

/** Never let text we send ping anyone (CLAUDE.md, discord-interactions skill). */
export interface AllowedMentions {
  parse: [];
  users?: string[];
}

export interface ButtonComponent {
  type: typeof COMPONENT_TYPE.BUTTON;
  style: (typeof BUTTON_STYLE)[keyof typeof BUTTON_STYLE];
  custom_id: string;
  label: string;
}

export interface ActionRowComponent {
  type: typeof COMPONENT_TYPE.ACTION_ROW;
  components: ButtonComponent[];
}

/** Body for a type 4/7 response, a PATCH @original, or a bot-token channel post. */
export interface MessageBody {
  content: string;
  allowed_mentions: AllowedMentions;
  flags?: number;
  components?: ActionRowComponent[];
}

export interface TextInputComponent {
  type: typeof COMPONENT_TYPE.TEXT_INPUT;
  custom_id: string;
  style: (typeof TEXT_INPUT_STYLE)[keyof typeof TEXT_INPUT_STYLE];
  min_length: number;
  max_length: number;
  required: boolean;
  placeholder: string;
}

export interface LabelComponent {
  type: typeof COMPONENT_TYPE.LABEL;
  label: string;
  description: string;
  component: TextInputComponent;
}

export type InteractionResponse =
  | { type: typeof CALLBACK_TYPE.PONG }
  | { type: typeof CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE; data: MessageBody }
  | { type: typeof CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE; data?: { flags: number } }
  | { type: typeof CALLBACK_TYPE.DEFERRED_UPDATE_MESSAGE }
  | { type: typeof CALLBACK_TYPE.UPDATE_MESSAGE; data: MessageBody }
  | {
      type: typeof CALLBACK_TYPE.MODAL;
      data: { custom_id: string; title: string; components: LabelComponent[] };
    };
