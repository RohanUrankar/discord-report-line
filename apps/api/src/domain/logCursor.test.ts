import { describe, expect, it } from 'vitest';

import { decodeLogCursor, encodeLogCursor } from './logCursor.js';

const CURSOR = { at: '2026-10-11T15:30:00.123456Z', id: '900000000000000004' };

describe('log cursor', () => {
  it('WHEN a cursor is encoded and decoded THE SYSTEM SHALL return the same position, microseconds included', () => {
    expect(decodeLogCursor(encodeLogCursor(CURSOR))).toEqual(CURSOR);
  });

  it('WHEN a cursor is encoded THE SYSTEM SHALL produce URL-safe text', () => {
    expect(encodeLogCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  const forged = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  it.each([
    ['junk', 'not a cursor'],
    ['an empty string', ''],
    ['base64 of text that is not JSON', Buffer.from('hello').toString('base64url')],
    ['a timestamp without microseconds', forged({ t: '2026-10-11T15:30:00.123Z', i: CURSOR.id })],
    ['SQL in the timestamp', forged({ t: "'; DROP TABLE job;--", i: CURSOR.id })],
    ['an id that is not a snowflake', forged({ t: CURSOR.at, i: "1' OR '1'='1" })],
    ['an extra key', forged({ t: CURSOR.at, i: CURSOR.id, x: 1 })],
    ['a missing key', forged({ t: CURSOR.at })],
    ['a JSON array', forged([CURSOR.at, CURSOR.id])],
  ])('WHEN the cursor is %s THE SYSTEM SHALL refuse it', (_name, raw) => {
    expect(decodeLogCursor(raw)).toBeUndefined();
  });
});
