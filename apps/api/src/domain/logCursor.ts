import { Snowflake } from '@report-line/shared';
import { z } from 'zod';

/**
 * Where the next page of the live log starts: just after the row with this creation time and id.
 * `at` is the database's own text for the timestamp, to the microsecond. A JS Date holds only
 * milliseconds, and a cursor that rounded would skip or repeat rows created within the same millisecond.
 */
export interface LogCursor {
  at: string;
  id: string;
}

const MICROSECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const CursorBody = z.object({ t: z.string().regex(MICROSECOND_UTC), i: Snowflake }).strict();

/** Opaque to clients (base64url of a small JSON object). It only narrows a query that is already tenant-scoped. */
export function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.at, i: cursor.id })).toString('base64url');
}

/** Undefined for anything this module did not produce: junk, truncation, a hand-edited value. */
export function decodeLogCursor(raw: string): LogCursor | undefined {
  try {
    const body = CursorBody.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return body.success ? { at: body.data.t, id: body.data.i } : undefined;
  } catch {
    return undefined;
  }
}
