// Builds every JSON body the bot sends to Discord (DESIGN §5.4, §7 ReplyBuilder). Pure: no I/O.
// Numeric types verified against docs.discord.com (interactions/receiving-and-responding,
// components/reference): see the constants below.

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

export const REPORT_MODAL_ID = 'report_modal';
export const REPORT_TEXT_INPUT_ID = 'report_text';
/** Same bound as the `/report text` option (§5.2), so both paths accept the same reports. */
export const REPORT_TEXT_MAX_LENGTH = 1000;

const MAX_CONTENT_LENGTH = 2000; // Discord message content limit

// Discord limits, verified on docs.discord.com (URLs in reply.test.ts).
export const DISCORD_LIMITS = {
  modalTitle: 45, // interactions/receiving-and-responding: Modal "title … max 45 characters"
  labelText: 45, // components/reference: Label "label … max 45 characters"
  labelDescription: 100, // components/reference: Label "description … max 100 characters"
  textInputPlaceholder: 100, // components/reference: Text Input "placeholder … max 100 characters"
  textInputMaxLength: 4000, // components/reference: Text Input "max_length … min 1, max 4000"
  customId: 100, // components/reference: custom_id "1-100 characters"
} as const;
const ECHO_MAX_LENGTH = 100; // how much of the user's own text we quote back
const SNOWFLAKE = /^\d{17,20}$/;

/** Every user-visible string the bot sends, in one place for review (user-facing-messages skill). */
export const MESSAGES = {
  unknownCommand: "I don't know that command.",
  disabled: 'This command is turned off on this server.',
  dmUnsupported: 'This bot only works in servers.',
  notRecorded: "We couldn't log that right now. Please try again in a minute.",
  statusUnavailable: "We couldn't check the status right now. Please try again in a minute.",
  emptyReport: 'Your report needs some text. Try `/report text: the printer is jammed`.',
  mirrorFailed:
    "⚠️ The team notification didn't go through. A server admin can see why on the dashboard.",
  modalTitle: 'Report a problem',
  modalLabel: "What's happening?",
  modalDescription: 'Give as much detail as you can.',
  modalPlaceholder: 'The printer on floor 2 is jammed',
  acknowledgeButton: 'Acknowledge',
  escalateButton: 'Escalate',
} as const;

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

export interface ReplyOptions {
  ephemeral: boolean;
}

export function pong(): InteractionResponse {
  return { type: CALLBACK_TYPE.PONG };
}

/** Type 4: an immediate reply (fast path, and every ephemeral error/notice). */
export function message(content: string, options: ReplyOptions): InteractionResponse {
  return { type: CALLBACK_TYPE.CHANNEL_MESSAGE_WITH_SOURCE, data: messageBody(content, options) };
}

/** Type 5: "thinking…" now, PATCH @original later. Ephemerality cannot be changed afterwards. */
export function deferMessage(options: ReplyOptions): InteractionResponse {
  return options.ephemeral
    ? { type: CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } }
    : { type: CALLBACK_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
}

/** Type 6: acknowledge a component now, edit the message later (slow button, §5.3). */
export function deferUpdate(): InteractionResponse {
  return { type: CALLBACK_TYPE.DEFERRED_UPDATE_MESSAGE };
}

/** Type 7: replace the message a component is attached to. Flags cannot change on an update. */
export function updateMessage(
  content: string,
  components: ActionRowComponent[] = [],
): InteractionResponse {
  return {
    type: CALLBACK_TYPE.UPDATE_MESSAGE,
    data: {
      content: truncate(content, MAX_CONTENT_LENGTH),
      allowed_mentions: { parse: [] },
      components,
    },
  };
}

/** Type 9: the `/report` form (§5.2). Label (18) wrapping a paragraph text input (4), per current docs. */
export function reportModal(): InteractionResponse {
  return {
    type: CALLBACK_TYPE.MODAL,
    data: {
      custom_id: REPORT_MODAL_ID,
      title: MESSAGES.modalTitle,
      components: [
        {
          type: COMPONENT_TYPE.LABEL,
          label: MESSAGES.modalLabel,
          description: MESSAGES.modalDescription,
          component: {
            type: COMPONENT_TYPE.TEXT_INPUT,
            custom_id: REPORT_TEXT_INPUT_ID,
            style: TEXT_INPUT_STYLE.PARAGRAPH,
            min_length: 1,
            max_length: REPORT_TEXT_MAX_LENGTH,
            required: true,
            placeholder: MESSAGES.modalPlaceholder,
          },
        },
      ],
    },
  };
}

/** A plain message body with mentions disabled and content cut to Discord's limit. */
export function messageBody(content: string, options: ReplyOptions): MessageBody {
  const body: MessageBody = {
    content: truncate(content, MAX_CONTENT_LENGTH),
    allowed_mentions: { parse: [] },
  };
  return options.ephemeral ? { ...body, flags: EPHEMERAL_FLAG } : body;
}

export interface ReportResult {
  replyMessage: string;
  /** True when the Slack mirror failed fatally (§11.3 step 2): the user is told honestly. */
  mirrorFailed: boolean;
  /** When set, the reply carries the Acknowledge / Escalate buttons for this report (§5.3). */
  reportId?: string;
}

/** Body for `PATCH @original` once the report job has run. Visibility was fixed at defer time. */
export function reportResultBody(result: ReportResult): MessageBody {
  const content = result.mirrorFailed
    ? `${result.replyMessage}\n${MESSAGES.mirrorFailed}`
    : result.replyMessage;
  const body: MessageBody = {
    content: truncate(content, MAX_CONTENT_LENGTH),
    allowed_mentions: { parse: [] },
  };
  return result.reportId === undefined
    ? body
    : { ...body, components: [reportButtons(result.reportId)] };
}

export interface ReportFallback {
  userId: string;
  reference: string;
  /** The rule's `ephemeral`. When true the report text is NEVER included (§11.3). */
  ephemeral: boolean;
  text: string;
}

/**
 * Public bot-token channel post used when the interaction token is dead (§11.3 step 4). Pings only the
 * reporter. Quotes their text only if they chose a public report, and never more than ~100 characters.
 */
export function reportFallbackBody(fallback: ReportFallback): MessageBody {
  const hasValidUser = SNOWFLAKE.test(fallback.userId);
  const who = hasValidUser ? `<@${fallback.userId}>, your` : 'Your';
  const quoted = fallback.ephemeral ? '' : `: “${truncate(fallback.text, ECHO_MAX_LENGTH)}”`;
  const reference = sanitiseReference(fallback.reference);
  return {
    content: truncate(
      `${who} report was logged${quoted} (ref \`${reference}\`)`,
      MAX_CONTENT_LENGTH,
    ),
    allowed_mentions: hasValidUser ? { parse: [], users: [fallback.userId] } : { parse: [] },
  };
}

const BUTTON_PREFIX = { acknowledge: 'rpt:ack:', escalate: 'rpt:esc:' } as const;
export type ReportButtonAction = keyof typeof BUTTON_PREFIX;

/** Acknowledge / Escalate buttons (§5.3). `custom_id` encodes intent + report id; it is untrusted on return. */
export function reportButtons(reportId: string): ActionRowComponent {
  return {
    type: COMPONENT_TYPE.ACTION_ROW,
    components: [
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.SUCCESS,
        custom_id: `${BUTTON_PREFIX.acknowledge}${reportId}`,
        label: MESSAGES.acknowledgeButton,
      },
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.PRIMARY,
        custom_id: `${BUTTON_PREFIX.escalate}${reportId}`,
        label: MESSAGES.escalateButton,
      },
    ],
  };
}

/**
 * Parses a button `custom_id` defensively. A valid parse only means the format is right: the caller must
 * still check that the report belongs to the interaction's guild before acting (§5.3, T-05).
 */
export function parseReportButton(
  customId: string,
): { action: ReportButtonAction; reportId: string } | undefined {
  for (const action of ['acknowledge', 'escalate'] as const) {
    const prefix = BUTTON_PREFIX[action];
    if (customId.startsWith(prefix)) {
      const reportId = customId.slice(prefix.length);
      return SNOWFLAKE.test(reportId) ? { action, reportId } : undefined;
    }
  }
  return undefined;
}

export interface StatusCounts {
  reportsToday: number;
  retrying: number;
  /** Seconds since the worker's last heartbeat; null when it has never reported. */
  workerLastBeatSeconds: number | null;
}

/** `/status` text (§5.1). */
export function statusText(counts: StatusCounts): string {
  const worker =
    counts.workerLastBeatSeconds === null
      ? "The worker hasn't checked in yet"
      : `Worker last active ${String(Math.max(0, Math.round(counts.workerLastBeatSeconds)))} s ago`;
  return `Reports today: ${String(counts.reportsToday)} · Retrying: ${String(counts.retrying)} · ${worker}.`;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text); // by code point, so an emoji is never split in half
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function sanitiseReference(reference: string): string {
  return reference.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
}
