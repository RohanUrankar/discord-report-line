import { describe, expect, it } from 'vitest';

import {
  InteractionDetail,
  InteractionLogItem,
  InteractionLogPage,
  LOG_PAGE_SIZE_DEFAULT,
  LOG_PAGE_SIZE_MAX,
  ListInteractionsQuery,
  Snowflake,
} from './index.js';

const ID = '900000000000000004';

const item = {
  id: ID,
  createdAt: '2026-10-11T15:30:00.000Z',
  command: 'report',
  userId: '900000000000000003',
  interactionStatus: 'followed_up',
  action: { type: 'report', mirrorStatus: 'failed', llmTag: null },
  job: { status: 'dead', attempts: 1, lastError: 'Slack says the webhook no longer exists.' },
};

describe('ListInteractionsQuery', () => {
  it('WHEN no parameters are given THE SYSTEM SHALL use the default page size', () => {
    expect(ListInteractionsQuery.parse({}).limit).toBe(LOG_PAGE_SIZE_DEFAULT);
  });

  it('WHEN limit is a numeric string THE SYSTEM SHALL read it as a number', () => {
    expect(ListInteractionsQuery.parse({ limit: '25' }).limit).toBe(25);
  });

  it.each([
    ['one over the cap', { limit: String(LOG_PAGE_SIZE_MAX + 1) }],
    ['zero', { limit: '0' }],
    ['a fraction', { limit: '2.5' }],
    ['not a number', { limit: 'many' }],
    ['a job status that does not exist', { status: 'exploded' }],
    ['an unknown parameter', { after: 'x' }],
    ['a repeated parameter', { status: ['dead', 'done'] }],
    ['an empty cursor', { cursor: '' }],
  ])('WHEN the query has %s THE SYSTEM SHALL reject it', (_name, query) => {
    expect(ListInteractionsQuery.safeParse(query).success).toBe(false);
  });

  it('WHEN limit is exactly the cap THE SYSTEM SHALL accept it', () => {
    expect(ListInteractionsQuery.parse({ limit: String(LOG_PAGE_SIZE_MAX) }).limit).toBe(
      LOG_PAGE_SIZE_MAX,
    );
  });
});

describe('response schemas', () => {
  it('WHEN a log row has exactly the allowed fields THE SYSTEM SHALL accept it', () => {
    expect(InteractionLogItem.safeParse(item).success).toBe(true);
    expect(InteractionLogPage.safeParse({ items: [item], nextCursor: null }).success).toBe(true);
  });

  it('WHEN a row carries a field outside the allow-list THE SYSTEM SHALL reject it', () => {
    expect(InteractionLogItem.safeParse({ ...item, interactionToken: 'x' }).success).toBe(false);
    expect(
      InteractionLogItem.safeParse({ ...item, job: { ...item.job, interaction_token: 'x' } })
        .success,
    ).toBe(false);
  });

  it('WHEN a detail has its attempt history THE SYSTEM SHALL accept it', () => {
    const detail = {
      ...item,
      attemptHistory: [
        {
          attemptNo: 1,
          target: 'mirror',
          outcome: 'fatal',
          httpStatus: 404,
          error: 'Slack says the webhook no longer exists (HTTP 404).',
          startedAt: '2026-10-11T15:30:01.000Z',
          finishedAt: '2026-10-11T15:30:01.200Z',
        },
      ],
    };

    expect(InteractionDetail.safeParse(detail).success).toBe(true);
    expect(
      InteractionDetail.safeParse({ ...detail, attemptHistory: [{ attemptNo: 0 }] }).success,
    ).toBe(false);
  });
});

describe('Snowflake', () => {
  it.each(['900000000000000004', '12345678901234567', '12345678901234567890'])(
    'WHEN %s is 17 to 20 digits THE SYSTEM SHALL accept it',
    (value) => {
      expect(Snowflake.safeParse(value).success).toBe(true);
    },
  );

  it.each(['', '1234567890123456', '123456789012345678901', '90000000000000000a', "1' OR '1'='1"])(
    'WHEN %j is not an id THE SYSTEM SHALL reject it',
    (value) => {
      expect(Snowflake.safeParse(value).success).toBe(false);
    },
  );
});
