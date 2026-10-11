import { z } from 'zod';

import {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  JobStatus,
  MirrorStatus,
  ReportTag,
  TagFallback,
  TagState,
} from './enums.js';

// Read API of the dashboard (DESIGN §2.3, §10.4). Every response schema is an explicit allow-list of fields:
// the API maps database rows into these shapes in one place and never passes a row through, so a column added
// later (an interaction token, a webhook) cannot reach a client by accident.

/** Rows per page of the live log when the client does not ask. */
export const LOG_PAGE_SIZE_DEFAULT = 50;
/** The most rows one page may hold, whatever the client asks for. */
export const LOG_PAGE_SIZE_MAX = 100;
/** Longest cursor the API accepts. A real one is about 90 characters. */
export const LOG_CURSOR_MAX_LENGTH = 200;

/** A Discord id. Ids are strings: snowflakes overflow JS numbers. */
export const Snowflake = z.string().regex(/^\d{17,20}$/);

const IsoTimestamp = z.iso.datetime();

/** `GET /api/guilds`: the servers this admin manages, and only those. */
export const GuildSummary = z
  .object({
    id: Snowflake,
    /** Null until the bot has seen the server's name (set when an admin connects it). */
    name: z.string().nullable(),
  })
  .strict();
export type GuildSummary = z.infer<typeof GuildSummary>;

export const GuildList = z.object({ items: z.array(GuildSummary) }).strict();
export type GuildList = z.infer<typeof GuildList>;

/** Query string of `GET /api/guilds/:guildId/interactions`. Unknown parameters are refused. */
export const ListInteractionsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(LOG_PAGE_SIZE_MAX).default(LOG_PAGE_SIZE_DEFAULT),
    /** The `nextCursor` of the previous page. Opaque: never build or edit one. */
    cursor: z.string().min(1).max(LOG_CURSOR_MAX_LENGTH).optional(),
    /** Keep only commands whose job has this status (`dead` is the failures view). */
    status: z.enum(JobStatus).optional(),
  })
  .strict();
export type ListInteractionsQuery = z.infer<typeof ListInteractionsQuery>;

/** What the bot did about a command. Report text is deliberately not part of it. */
const ActionView = z
  .object({
    type: z.enum(ActionType),
    mirrorStatus: z.enum(MirrorStatus),
    /**
     * A `ReportTag`, `untagged` (tagging failed), or null (no tag: off or not run yet). Always in this set:
     * a stored value outside it is reported as `untagged`. Read `tagState` to tell the cases apart.
     */
    llmTag: z.union([z.enum(ReportTag), z.literal(TagFallback)]).nullable(),
    /** `tagged`, `untagged` (failed), `pending` (job has not tagged yet) or `off` (disabled or not a report). */
    tagState: z.enum(TagState),
  })
  .strict();

/** The background work behind a command. `lastError` is already readable text with no link in it. */
const JobView = z
  .object({
    status: z.enum(JobStatus),
    attempts: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
  })
  .strict();

/** One row of the live log: the command, its action and its job (null for commands answered inline). */
export const InteractionLogItem = z
  .object({
    id: Snowflake,
    createdAt: IsoTimestamp,
    /** Null for a component click, which has no command name. */
    command: z.string().nullable(),
    userId: Snowflake,
    interactionStatus: z.enum(InteractionStatus),
    action: ActionView.nullable(),
    job: JobView.nullable(),
  })
  .strict();
export type InteractionLogItem = z.infer<typeof InteractionLogItem>;

/** `GET /api/guilds/:guildId/interactions`: newest first. `nextCursor` is null on the last page. */
export const InteractionLogPage = z
  .object({
    items: z.array(InteractionLogItem),
    nextCursor: z.string().min(1).max(LOG_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type InteractionLogPage = z.infer<typeof InteractionLogPage>;

/** One outbound call the worker made for a job. */
export const AttemptView = z
  .object({
    attemptNo: z.number().int().positive(),
    target: z.enum(AttemptTarget),
    outcome: z.enum(AttemptOutcome),
    httpStatus: z.number().int().nullable(),
    error: z.string().nullable(),
    startedAt: IsoTimestamp,
    finishedAt: IsoTimestamp.nullable(),
  })
  .strict();
export type AttemptView = z.infer<typeof AttemptView>;

/** `GET /api/guilds/:guildId/interactions/:id`: the log row plus every attempt, oldest first. */
export const InteractionDetail = InteractionLogItem.extend({
  attemptHistory: z.array(AttemptView),
}).strict();
export type InteractionDetail = z.infer<typeof InteractionDetail>;
