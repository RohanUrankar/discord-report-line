import type {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  JobStatus,
  MirrorStatus,
} from '@report-line/shared';

import type { LogCursor } from '../domain/logCursor.js';

export interface GuildRecord {
  id: string;
  name: string | null;
}

/** One live-log row as stored: interaction joined with its action and job. Only columns the dashboard shows. */
export interface LogRecord {
  id: string;
  createdAt: Date;
  /** The database's microsecond text for `createdAt`; what a cursor is made of. */
  createdAtExact: string;
  command: string | null;
  userId: string;
  interactionStatus: InteractionStatus;
  action: { type: ActionType; mirrorStatus: MirrorStatus; llmTag: string | null } | null;
  job: { status: JobStatus; attempts: number; lastError: string | null } | null;
}

export interface AttemptRecord {
  attemptNo: number;
  target: AttemptTarget;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface LogQuery {
  /** Rows to return, at most. */
  limit: number;
  after?: LogCursor;
  jobStatus?: JobStatus;
}

/** The keyset position could not be used by the store (e.g. a timestamp the database refuses). A client error. */
export class InvalidCursorError extends Error {
  public constructor() {
    super('The log cursor was refused by the store.');
    this.name = 'InvalidCursorError';
  }
}

/**
 * Read side of the dashboard (DESIGN §2.3). Every method takes the signed-in admin AND the guild, and the
 * adapter's SQL checks `admin_guild` itself: the `TenantGuard` middleware is the first lock, this is the
 * second, so a route that forgets the guard still returns nothing for a guild the admin does not manage.
 * A missing or foreign guild is simply an empty answer; the caller cannot tell them apart.
 * Rejects when the database is unreachable; `listInteractions` rejects with `InvalidCursorError` when the store
 * refuses the cursor's timestamp.
 */
export interface DashboardReader {
  managesGuild(adminId: string, guildId: string): Promise<boolean>;
  listGuilds(adminId: string): Promise<GuildRecord[]>;
  /** Newest first, ordered by (created_at, id) descending. */
  listInteractions(adminId: string, guildId: string, query: LogQuery): Promise<LogRecord[]>;
  findInteraction(
    adminId: string,
    guildId: string,
    interactionId: string,
  ): Promise<{ row: LogRecord; attempts: AttemptRecord[] } | undefined>;
}
