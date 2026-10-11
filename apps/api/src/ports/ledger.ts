import type { ReportJobPayload } from '../domain/reportJob.js';
import type { ActionType, InteractionStatus, JobKind, MirrorStatus } from '../domain/types.js';

/** The interaction row. `id` is Discord's interaction id and the dedupe key (DESIGN §9). */
export interface RecordedInteraction {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  /** Discord's numeric interaction type. */
  type: number;
  commandName: string | null;
  customId: string | null;
  options: Record<string, unknown> | null;
  status: InteractionStatus;
}

/** The action row: what the bot did, plus the step markers the worker resumes from (DESIGN §9, §11.3). */
export interface RecordedAction {
  type: ActionType;
  summary: string | null;
  mirrorStatus: MirrorStatus;
}

/**
 * The outbox row. The token is a 15-minute credential: it goes to its own column and nowhere else
 * (not the options, not the summary, not a log).
 */
export interface EnqueuedJob {
  kind: JobKind;
  interactionToken: string;
  tokenExpiresAt: Date;
  /** The rule snapshot and report the worker needs (DESIGN §9). Holds no credential. */
  payload: ReportJobPayload;
}

export interface RecordInput {
  interaction: RecordedInteraction;
  action: RecordedAction;
  /** Present only for work that continues after the reply (a deferred /report). */
  job?: EnqueuedJob;
}

/** `won`: this call recorded the interaction. `duplicate`: another delivery already had; nothing was written. */
export type RecordOutcome = 'won' | 'duplicate';

/** Dedupe + outbox in one transaction (DESIGN §8.1, §10.3). */
export interface LedgerService {
  /**
   * One transaction: ensure the guild exists, INSERT the interaction ON CONFLICT (id) DO NOTHING, and only if
   * that insert won, INSERT the action and (when given) the job. All of it commits, or none of it does.
   * Rejects when the database cannot be reached or the write fails; the caller must not claim success then.
   */
  recordAndEnqueue(input: RecordInput): Promise<RecordOutcome>;
}
