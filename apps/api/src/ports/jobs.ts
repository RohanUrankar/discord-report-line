import type {
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  MirrorStatus,
} from '../domain/types.js';

/** A job the worker holds a lease on, with everything one pass needs, read in the claim statement. */
export interface ClaimedJob {
  id: string;
  interactionId: string;
  guildId: string;
  /** Passes started so far, this one included: the claim increments it (DESIGN §7.1). */
  attempts: number;
  /** When this lease began. Every later write is guarded by it, so a worker that lost its lease writes nothing. */
  claimedAt: Date;
  /** NULL once cleared. A 15-minute credential: never logged. */
  interactionToken: string | null;
  tokenExpiresAt: Date | null;
  /** The raw JSON column; the runner validates it (backend-guidelines: validate data read from JSON). */
  payload: unknown;
  mirrorStatus: MirrorStatus;
  /** `ACTION.llm_tag`: NULL until the tagging step has run (or when it never will), then a tag or `untagged`. */
  llmTag: string | null;
  /** AES-GCM ciphertext of the server's Slack webhook URL, if one is set. */
  mirrorWebhookEnc: Buffer | null;
  /** The server's notification channel, if an admin picked one. */
  postChannelId: string | null;
  /** The channel the command ran in. */
  channelId: string;
}

export interface ClaimRequest {
  limit: number;
  nowMs: number;
  leaseMs: number;
}

/** One row of job_attempt: one outbound call, or the decision not to make it. */
export interface AttemptRecord {
  attemptNo: number;
  target: AttemptTarget;
  outcome: AttemptOutcome;
  httpStatus: number | undefined;
  /** Written for a human admin: no URL, token or response body. */
  error: string | undefined;
  startedAt: Date;
  finishedAt: Date;
}

/** Where the job goes after a step. Absent means the pass continues with the next step. */
export type StepNext =
  | { kind: 'retry'; runAt: Date }
  | { kind: 'finish'; jobStatus: 'done' | 'dead'; interactionStatus: InteractionStatus };

/** Everything one step changes, applied together with its attempt row (DESIGN §11.3: markers commit at once). */
export interface StepEffect {
  mirrorStatus?: Extract<MirrorStatus, 'sent' | 'failed' | 'skipped'>;
  /** The tagging step's result: a `ReportTag`, or `untagged`. Written once, together with its attempt row. */
  llmTag?: string;
  /** Clear the interaction token now (a fatal follow-up). `finish` always clears it. */
  clearToken?: boolean;
  /** Replaces `last_error`. A `done` finish clears it instead. */
  lastError?: string;
  next?: StepNext;
}

/** `lease_lost`: another worker holds the job now; nothing was written. */
export type CommitResult = 'applied' | 'lease_lost';

/** The worker's view of the outbox (DESIGN §8.2: JobRepo, narrowed). */
export interface JobRepository {
  /**
   * One statement: pick due jobs (`FOR UPDATE SKIP LOCKED`), including ones whose lease expired, stamp the
   * lease, count the pass, and return them. Committed before the caller makes any network call.
   */
  claim(request: ClaimRequest): Promise<ClaimedJob[]>;
  /**
   * One transaction: the attempt row (when the step made a call) and the step's effect. Guarded by the lease.
   * The attempt row and the marker commit together, so "mirrored" can never be recorded without its history.
   */
  commitStep(
    job: ClaimedJob,
    attempt: AttemptRecord | null,
    effect: StepEffect,
  ): Promise<CommitResult>;
}
