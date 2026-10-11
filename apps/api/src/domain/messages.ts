/** Every user-visible string the bot sends, in one place for review (user-facing-messages skill). */
export const MESSAGES = {
  unknownCommand: "I don't know that command.",
  disabled: 'This command is turned off on this server.',
  dmUnsupported: 'This bot only works in servers.',
  notRecorded: "We couldn't log that right now. Please try again in a minute.",
  statusUnavailable: "We couldn't check the status right now. Please try again in a minute.",
  unknownForm: "I don't recognise that form. Run `/report` to start again.",
  unknownButton: "I don't recognise that button.",
  emptyReport: 'Your report needs some text. Try `/report text: the printer is jammed`.',
  reportTooLong: 'Your report is too long. Keep it under 1,000 characters and try again.',
  mirrorFailed:
    "⚠️ The team notification didn't go through. A server admin can see why on the dashboard.",
  modalTitle: 'Report a problem',
  modalLabel: "What's happening?",
  modalDescription: 'Give as much detail as you can.',
  modalPlaceholder: 'The printer on floor 2 is jammed',
  reportNotFound: "I can't find that report on this server.",
  acknowledgeButton: 'Acknowledge',
  escalateButton: 'Escalate',
} as const;

/** What the dashboard shows for an answered command (ACTION.summary). Fixed text: no user input in it. */
export const ACTION_SUMMARIES = {
  status: 'Showed the status counts.',
  disabled: 'Replied that the command is turned off.',
  unknown_command: 'Replied that the command is not recognised.',
  report: 'Logged a report.',
  acknowledged: 'Acknowledged a report.',
  escalated: 'Escalated a report.',
} as const;

/** Who did what to a report, shown on the updated message. Mentions render but ping nobody (parse: []). */
export const STATE_LINES = {
  acknowledgedBy: (userId: string): string => `✅ Acknowledged by <@${userId}>`,
  escalatedBy: (userId: string): string => `🚨 Escalated by <@${userId}>`,
  alreadyAcknowledgedBy: (userId: string): string =>
    `This report was already acknowledged by <@${userId}>.`,
  alreadyEscalatedBy: (userId: string): string =>
    `This report was already escalated by <@${userId}>.`,
} as const;
