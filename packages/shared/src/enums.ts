// Closed value sets shared by the API, the migration CHECK constraints and the dashboard (DESIGN §8.3, §9).
// One list per set: each tuple is the single source, and its union type is derived from it.

export const JobStatus = ['pending', 'processing', 'done', 'dead'] as const;
export type JobStatus = (typeof JobStatus)[number];

export const JobKind = ['report', 'component'] as const;
export type JobKind = (typeof JobKind)[number];

export const AttemptOutcome = ['success', 'retryable', 'fatal'] as const;
export type AttemptOutcome = (typeof AttemptOutcome)[number];

export const AttemptTarget = ['tag', 'mirror', 'followup', 'fallback'] as const;
export type AttemptTarget = (typeof AttemptTarget)[number];

export const InteractionStatus = [
  'answered',
  'deferred',
  'followed_up',
  'fallback_posted',
  'failed',
] as const;
export type InteractionStatus = (typeof InteractionStatus)[number];

export const ActionType = [
  'report',
  'status',
  'disabled',
  'unknown_command',
  'acknowledged',
  'escalated',
] as const;
export type ActionType = (typeof ActionType)[number];

export const MirrorStatus = ['pending', 'sent', 'failed', 'skipped'] as const;
export type MirrorStatus = (typeof MirrorStatus)[number];

/** `ACTION.llm_tag` value when tagging is off, fails, or returns output outside the allowed set. */
export const TagFallback = 'untagged';
export type TagFallback = typeof TagFallback;
