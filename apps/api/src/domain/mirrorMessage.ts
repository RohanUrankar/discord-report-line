// The Slack notification text for a report (user-facing-messages skill: what first, then who and where).
import { truncate } from './discordText.js';
import { REPORT_TEXT_MAX_LENGTH } from './commands.js';

/**
 * Slack's mrkdwn gives `<...>` special meaning (`<!channel>`, `<@U123>`, `<https://x|label>`), so user text must
 * have `&`, `<` and `>` escaped, in that order, before it is sent (Slack docs: "Formatting text for app
 * surfaces": escaping). Anything else is shown literally.
 */
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface MirrorMessageInput {
  text: string;
  userId: string;
  channelId: string;
}

/** The report is user text and untrusted. The ids are Discord snowflakes validated at the edge (digits only). */
export function mirrorMessage(input: MirrorMessageInput): string {
  const report = escapeSlackText(truncate(input.text, REPORT_TEXT_MAX_LENGTH));
  return `🆕 New report from Discord user ${input.userId} in channel ${input.channelId}: “${report}”`;
}
