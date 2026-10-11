// Dashboard copy that is not an API error (user-facing-messages): calm, specific, second person. "Server" and
// "command" for people; Discord's own words (guild, interaction) stay in the code.

/**
 * The same text for "no such server" and "someone else manages it": the API deliberately does not say which,
 * and neither may the UI.
 */
export const CONNECT_NOT_FOUND_MESSAGE =
  "We couldn't connect that server. Check the server id and that the bot has been added to that server. " +
  'If it has, run /status there once and try again.';

/**
 * Shown on the rules page while the bot does not yet read saved rules when it answers a command.
 * ONE place, so Step 5 (rules at interaction time) removes the notice by setting this to null.
 */
export const RULES_NOT_APPLIED_NOTICE: string | null =
  'Changes are saved but not yet applied to live commands.';

export const WEBHOOK_WRITE_ONLY_HINT =
  'For safety this address is never shown again once saved. To change it, paste a new one.';

export const SLACK_CONFIGURED_LABEL = 'Slack notifications: configured';
export const SLACK_NOT_CONFIGURED_LABEL = 'Slack notifications: not configured';
