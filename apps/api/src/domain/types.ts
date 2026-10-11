// Backend-only domain types (DESIGN §8.3). The enum tuples are defined once in @report-line/shared and
// re-exported here by name, so domain code imports every type it needs from one place.
export {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  JobKind,
  JobStatus,
  MirrorStatus,
  ReportTag,
  TagFallback,
  TagState,
  type CommandName,
} from '@report-line/shared';

/**
 * What the bot does about a command, decided by `evaluate` (rules.ts).
 * `report` does not choose modal vs defer: the handler decides from whether the `text` option is present
 * (§5.2). Buttons (§5.3) are not rule-driven in v1.
 */
export type Action =
  | { type: 'unknown_command' }
  | { type: 'disabled' }
  | { type: 'status'; ephemeral: boolean }
  | { type: 'report'; ephemeral: boolean; replyMessage: string; mirror: boolean; tag: boolean };

/** Who ran the interaction. */
export interface Actor {
  userId: string;
}

/** Where the interaction happened. The guild comes from the signed payload, so it is trustworthy. */
export interface Tenant {
  guildId: string;
  channelId: string;
}

/** The message a component was attached to. */
export interface MessageRef {
  messageId: string;
}
