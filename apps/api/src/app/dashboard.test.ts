import { LOG_PAGE_SIZE_DEFAULT, type ListInteractionsQuery } from '@report-line/shared';
import { describe, expect, it } from 'vitest';

import { decodeLogCursor, encodeLogCursor } from '../domain/logCursor.js';
import {
  InvalidCursorError,
  type DashboardReader,
  type LogQuery,
  type LogRecord,
} from '../ports/dashboard.js';
import { DashboardService } from './dashboard.js';

const ADMIN = 'a0000000-0000-4000-8000-000000000001';
const GUILD = '900000000000000001';

function record(n: number): LogRecord {
  const id = String(900000000000000100 + n);
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 9, 11, 15, 30, 0, 0)),
    createdAtExact: `2026-10-11T15:30:00.${String(n).padStart(6, '0')}Z`,
    command: 'report',
    userId: '900000000000000003',
    interactionStatus: 'followed_up',
    action: { type: 'report', mirrorStatus: 'sent', llmTag: null },
    job: { status: 'done', attempts: 1, lastError: null },
  };
}

/** A reader over a fixed list that records the query it was given and honours `limit`. */
function readerOf(rows: LogRecord[]): DashboardReader & { seen: LogQuery[] } {
  const seen: LogQuery[] = [];
  return {
    seen,
    managesGuild: () => Promise.resolve(true),
    listGuilds: () => Promise.resolve([]),
    listInteractions: (_admin, _guild, query) => {
      seen.push(query);
      return Promise.resolve(rows.slice(0, query.limit));
    },
    findInteraction: () => Promise.resolve(undefined),
  };
}

const query = (overrides: Partial<ListInteractionsQuery> = {}): ListInteractionsQuery => ({
  limit: LOG_PAGE_SIZE_DEFAULT,
  ...overrides,
});

describe('DashboardService.listInteractions', () => {
  it('WHEN there are more rows than the page size THE SYSTEM SHALL return one page and a cursor at its last row', async () => {
    const reader = readerOf([record(5), record(4), record(3)]);

    const result = await new DashboardService(reader).listInteractions(
      ADMIN,
      GUILD,
      query({ limit: 2 }),
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      return;
    }
    expect(result.page.items.map((item) => item.id)).toEqual([record(5).id, record(4).id]);
    expect(decodeLogCursor(result.page.nextCursor ?? '')).toEqual({
      at: record(4).createdAtExact,
      id: record(4).id,
    });
    expect(reader.seen[0]?.limit).toBe(3); // one extra row proves another page exists
  });

  it('WHEN the rows fit in one page THE SYSTEM SHALL return no cursor', async () => {
    const result = await new DashboardService(readerOf([record(2), record(1)])).listInteractions(
      ADMIN,
      GUILD,
      query({ limit: 2 }),
    );

    expect(result).toMatchObject({ kind: 'ok', page: { nextCursor: null } });
  });

  it('WHEN the guild has no rows THE SYSTEM SHALL return an empty page', async () => {
    const result = await new DashboardService(readerOf([])).listInteractions(ADMIN, GUILD, query());

    expect(result).toEqual({ kind: 'ok', page: { items: [], nextCursor: null } });
  });

  it('WHEN a cursor and a status are given THE SYSTEM SHALL pass both to the reader', async () => {
    const reader = readerOf([]);
    const cursor = { at: record(4).createdAtExact, id: record(4).id };

    await new DashboardService(reader).listInteractions(
      ADMIN,
      GUILD,
      query({ cursor: encodeLogCursor(cursor), status: 'dead' }),
    );

    expect(reader.seen[0]).toMatchObject({ after: cursor, jobStatus: 'dead' });
  });

  it('WHEN the cursor is not one THE SYSTEM SHALL say so and not touch the reader', async () => {
    const reader = readerOf([record(1)]);

    const result = await new DashboardService(reader).listInteractions(
      ADMIN,
      GUILD,
      query({ cursor: 'garbage' }),
    );

    expect(result).toEqual({ kind: 'invalid_cursor' });
    expect(reader.seen).toHaveLength(0);
  });

  it('WHEN the store refuses the cursor THE SYSTEM SHALL answer invalid_cursor', async () => {
    const reader: DashboardReader = {
      ...readerOf([]),
      listInteractions: () => Promise.reject(new InvalidCursorError()),
    };
    const cursor = encodeLogCursor({ at: record(4).createdAtExact, id: record(4).id });

    const result = await new DashboardService(reader).listInteractions(
      ADMIN,
      GUILD,
      query({ cursor }),
    );

    expect(result).toEqual({ kind: 'invalid_cursor' });
  });

  it('WHEN the reader fails THE SYSTEM SHALL let the failure propagate', async () => {
    const reader: DashboardReader = {
      ...readerOf([]),
      listInteractions: () => Promise.reject(new Error('db down')),
    };

    await expect(
      new DashboardService(reader).listInteractions(ADMIN, GUILD, query()),
    ).rejects.toThrow('db down');
  });
});
