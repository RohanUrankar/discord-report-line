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

/**
 * The tags the LLM may choose from (DESIGN §11.3 step 1, rev 8). The one list: the Gemini response schema, the
 * validation of its output, the Slack line and the dashboard all read it. A model answer outside it is discarded.
 */
export const ReportTag = ['outage', 'bug', 'security', 'abuse', 'question', 'feedback', 'other'] as const;
export type ReportTag = (typeof ReportTag)[number];

/**
 * `ACTION.llm_tag` value when tagging was attempted and failed, or the model returned output outside
 * `ReportTag`. NULL means no tag was attempted (LLM or the rule's tag option off) or it has not run yet.
 */
export const TagFallback = 'untagged';
export type TagFallback = typeof TagFallback;

/**
 * What the dashboard shows about a report's tag, derived from `llm_tag` and the job (never stored):
 * `tagged` a tag from `ReportTag`; `untagged` tagging was tried and failed; `pending` the job has not reached
 * the tagging step yet; `off` it will not or did not run (LLM disabled, or the rule's tag option off, or the
 * command is not a report).
 */
export const TagState = ['tagged', 'untagged', 'pending', 'off'] as const;
export type TagState = (typeof TagState)[number];
