// Generic interaction responses and message bodies. Pure: no I/O. Feature-specific bodies live elsewhere.
import {
  CALLBACK_TYPE,
  EPHEMERAL_FLAG,
  MAX_CONTENT_LENGTH,
  type ActionRowComponent,
  type AllowedMentions,
  type InteractionResponse,
  type MessageBody,
} from './discordProtocol.js';
import { truncate } from './discordText.js';

export interface ReplyOptions {
  ephemeral: boolean;
}

/**
 * The single place a message body is built: content cut to Discord's limit and mentions disabled unless
 * the caller names exactly who may be pinged. Every outgoing body goes through here.
 */
export function plainBody(
  content: string,
  allowedMentions: AllowedMentions = { parse: [] },
): MessageBody {
  return { content: truncate(content, MAX_CONTENT_LENGTH), allowed_mentions: allowedMentions };
}

/** A plain message body, ephemeral when asked. */
export function messageBody(content: string, options: ReplyOptions): MessageBody {
  const body = plainBody(content);
  return options.ephemeral ? { ...body, flags: EPHEMERAL_FLAG } : body;
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
  return { type: CALLBACK_TYPE.UPDATE_MESSAGE, data: { ...plainBody(content), components } };
}
