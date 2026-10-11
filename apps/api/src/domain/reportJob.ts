// The snapshot a deferred /report leaves for the worker (DESIGN §9, job.payload). Taken at defer time so
// an admin editing the rule afterwards cannot change what an in-flight report does. No credentials here:
// the interaction token has its own column.
import { z } from 'zod';

import { REPORT_TEXT_MAX_LENGTH, REPORT_TEXT_MIN_LENGTH } from './commands.js';

/**
 * Discord's interaction token lives 15 minutes. We stop trusting it 30 s early, so a PATCH that would
 * land at the very edge goes straight to the channel fallback instead of failing with a 401 first.
 */
export const TOKEN_SAFE_LIFETIME_MS = 14 * 60_000 + 30_000;

const REPLY_MESSAGE_MAX = 300; // ReportRuleConfig.replyMessage max (DESIGN §8.3)
const Snowflake = z.string().regex(/^\d{17,20}$/);

export const ReportJobPayload = z
  .object({
    /** The report, already trimmed. Untrusted text: it is escaped or neutralised everywhere it is sent. */
    text: z.string().min(REPORT_TEXT_MIN_LENGTH).max(REPORT_TEXT_MAX_LENGTH),
    userId: Snowflake,
    /** Where the command ran: the fallback post goes here when the server has no notification channel. */
    channelId: Snowflake,
    ephemeral: z.boolean(),
    replyMessage: z.string().min(1).max(REPLY_MESSAGE_MAX),
    mirror: z.boolean(),
    tag: z.boolean(),
  })
  .strict();
export type ReportJobPayload = z.infer<typeof ReportJobPayload>;

export type PayloadParse = { ok: true; payload: ReportJobPayload } | { ok: false };

/** Reads a payload back from the database. Never throws; the worker marks an unreadable one dead. */
export function parseReportJobPayload(json: unknown): PayloadParse {
  const result = ReportJobPayload.safeParse(json);
  return result.success ? { ok: true, payload: result.data } : { ok: false };
}
