import {
  GuildList,
  InteractionDetail,
  InteractionLogPage,
  LOG_PAGE_SIZE_DEFAULT,
  LOG_PAGE_SIZE_MAX,
} from '@report-line/shared';
import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  makeDashboardKit,
  type Admin,
  type DashboardKit,
} from '../../test/helpers/dashboardKit.js';
import { useTestDatabase } from '../../test/helpers/db.js';
import { GUILD_ID, INTERACTION_ID } from '../../test/helpers/payloads.js';
import { thenOk } from '../../test/helpers/stubServer.js';
import { seedReport, usePipeline, WEBHOOK_SECRET } from '../../test/helpers/workerHarness.js';

const db = useTestDatabase();
const pipeline = usePipeline(db);

const GUILD_A = '900000000000000101';
const GUILD_B = '900000000000000102';
const UNKNOWN_GUILD = '900000000000000199';
const SENTINEL_TOKEN = 'SENTINEL-INTERACTION-TOKEN-4f1c';
const SENTINEL_WEBHOOK = 'SENTINEL-WEBHOOK-CIPHERTEXT-9a7e';
const REQUEST_ID = 'req-identical-1';

let kit: DashboardKit;
let adminA: Admin;
let adminB: Admin;

beforeEach(async () => {
  kit = makeDashboardKit(db());
  adminA = await kit.signIn('a@example.test');
  adminB = await kit.signIn('b@example.test');
  await kit.manage(adminA, GUILD_A);
  await kit.manage(adminB, GUILD_B);
});

interface RowSeed {
  id: string;
  guildId: string;
  /** Postgres timestamp text; microseconds let a test make rows that differ by less than a millisecond. */
  createdAt?: string;
  job?: 'pending' | 'dead' | 'done';
}

/** A row written straight to the tables, with the secrets a response must never contain. */
async function insertRow(pool: pg.Pool, seed: RowSeed): Promise<void> {
  const createdAt = seed.createdAt ?? new Date().toISOString();
  await pool.query(
    `INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET mirror_webhook_enc = EXCLUDED.mirror_webhook_enc`,
    [seed.guildId, Buffer.from(SENTINEL_WEBHOOK)],
  );
  await pool.query(
    `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, command_name, status, created_at)
     VALUES ($1, $2, '900000000000000002', '900000000000000003', 2, 'report', 'deferred', $3)`,
    [seed.id, seed.guildId, createdAt],
  );
  await pool.query(
    `INSERT INTO action (interaction_id, guild_id, type, mirror_status, created_at)
     VALUES ($1, $2, 'report', 'pending', $3)`,
    [seed.id, seed.guildId, createdAt],
  );
  if (seed.job !== undefined) {
    await pool.query(
      `INSERT INTO job (interaction_id, guild_id, kind, interaction_token, status, attempts)
       VALUES ($1, $2, 'report', $3, $4, 1)`,
      [seed.id, seed.guildId, SENTINEL_TOKEN, seed.job],
    );
  }
}

/** `count` plain rows, one second apart, newest first by id. */
async function bulkRows(pool: pg.Pool, guildId: string, count: number): Promise<void> {
  await pool.query(
    `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, command_name, status, created_at)
     SELECT (900000000001000000 + n)::text, $1, '900000000000000002', '900000000000000003', 2,
            'status', 'answered', now() - n * interval '1 second'
       FROM generate_series(1, $2::int) AS n`,
    [guildId, count],
  );
}

const pageOf = (body: unknown): InteractionLogPage => InteractionLogPage.parse(body);

describe('dashboard read API: authentication', () => {
  it.each([
    ['the guild list', '/api/guilds'],
    ['a guild log', `/api/guilds/${GUILD_A}/interactions`],
    ['one command', `/api/guilds/${GUILD_A}/interactions/${INTERACTION_ID}`],
  ])(
    'WHEN an unauthenticated user asks for %s THE SYSTEM SHALL answer 401 and return no data',
    async (_name, path) => {
      await insertRow(db(), { id: INTERACTION_ID, guildId: GUILD_A });

      const res = await kit.get(undefined, path);

      expect(res.status).toBe(401);
      expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
      expect(res.text).not.toContain(INTERACTION_ID);
    },
  );
});

describe('dashboard read API: tenant isolation', () => {
  beforeEach(async () => {
    await insertRow(db(), { id: '900000000000000201', guildId: GUILD_A });
    await insertRow(db(), { id: '900000000000000202', guildId: GUILD_B, job: 'pending' });
  });

  it('WHEN an admin lists the servers THE SYSTEM SHALL return only the ones they manage', async () => {
    await db().query("UPDATE guild SET name = 'Server B' WHERE id = $1", [GUILD_B]);

    const a = GuildList.parse((await kit.get(adminA, '/api/guilds')).body);
    const b = GuildList.parse((await kit.get(adminB, '/api/guilds')).body);

    expect(a.items).toEqual([{ id: GUILD_A, name: null }]);
    expect(b.items).toEqual([{ id: GUILD_B, name: 'Server B' }]);
  });

  it('WHEN admin A asks for a server B manages, one that does not exist, or a malformed id THE SYSTEM SHALL answer the same 404 body byte for byte', async () => {
    const paths = [
      `/api/guilds/${GUILD_B}/interactions`,
      `/api/guilds/${GUILD_B}/interactions/900000000000000202`,
      `/api/guilds/${UNKNOWN_GUILD}/interactions`,
      `/api/guilds/${UNKNOWN_GUILD}/interactions/900000000000000202`,
      '/api/guilds/not-an-id/interactions',
      `/api/guilds/${GUILD_A}/interactions/900000000000000299`, // missing in A's own guild
      `/api/guilds/${GUILD_A}/interactions/900000000000000202`, // B's command via A's guild path
      `/api/guilds/${GUILD_A}/interactions/not-an-id`,
    ];

    const responses = await Promise.all(paths.map((path) => kit.get(adminA, path, REQUEST_ID)));

    expect(responses.map((res) => res.status)).toEqual(paths.map(() => 404));
    const [first, ...rest] = responses.map((res) => res.text);
    expect(first).toContain('NOT_FOUND');
    for (const text of rest) {
      expect(text).toBe(first);
    }
    expect(first).not.toContain('900000000000000202');
  });

  it('WHEN admin A is refused a server THE SYSTEM SHALL log a tenant.access_denied security event with ids only', async () => {
    await kit.get(adminA, `/api/guilds/${GUILD_B}/interactions`);
    await kit.get(adminA, '/api/guilds/not-an-id%0Ainjected/interactions');

    const events = kit.logs.records().filter((record) => record.event === 'tenant.access_denied');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      logType: 'security',
      result: 'failed',
      reason: 'not_managed',
      adminId: adminA.id,
      guildId: GUILD_B,
    });
    expect(events[1]).toMatchObject({ reason: 'malformed_guild_id', adminId: adminA.id });
    expect(events[1]).not.toHaveProperty('guildId');
    expect(kit.logs.text()).not.toContain(SENTINEL_TOKEN);
    expect(kit.logs.text()).not.toContain('injected');
  });

  it('WHEN admin B asks for their own server and command THE SYSTEM SHALL return them', async () => {
    const list = await kit.get(adminB, `/api/guilds/${GUILD_B}/interactions`);
    const detail = await kit.get(adminB, `/api/guilds/${GUILD_B}/interactions/900000000000000202`);

    expect(list.status).toBe(200);
    expect(pageOf(list.body).items.map((item) => item.id)).toEqual(['900000000000000202']);
    expect(detail.status).toBe(200);
    expect(InteractionDetail.parse(detail.body).id).toBe('900000000000000202');
  });

  it('WHEN the session belongs to an admin who manages nothing THE SYSTEM SHALL list no servers and refuse every server path', async () => {
    const stranger = await kit.signIn('c@example.test');

    const guilds = await kit.get(stranger, '/api/guilds');
    const log = await kit.get(stranger, `/api/guilds/${GUILD_A}/interactions`);

    expect(GuildList.parse(guilds.body).items).toEqual([]);
    expect(log.status).toBe(404);
  });
});

describe('dashboard read API: nothing secret in any response', () => {
  it('WHEN rows hold an interaction token and a webhook ciphertext THE SYSTEM SHALL return neither from any endpoint', async () => {
    await insertRow(db(), { id: '900000000000000301', guildId: GUILD_B, job: 'pending' });
    const paths = [
      '/api/guilds',
      `/api/guilds/${GUILD_B}/interactions`,
      `/api/guilds/${GUILD_B}/interactions?status=pending`,
      `/api/guilds/${GUILD_B}/interactions/900000000000000301`,
    ];

    const bodies = await Promise.all(
      paths.map(async (path): Promise<unknown> => (await kit.get(adminB, path)).body),
    );

    const forbidden = [
      SENTINEL_TOKEN,
      SENTINEL_WEBHOOK,
      Buffer.from(SENTINEL_WEBHOOK).toString('base64'),
      Buffer.from(SENTINEL_WEBHOOK).toString('hex'),
      'interaction_token',
      'interactionToken',
      'mirror_webhook',
      'mirrorWebhook',
    ];
    for (const body of bodies) {
      const json = JSON.stringify(body);
      for (const needle of forbidden) {
        expect(json).not.toContain(needle);
      }
    }
    // The job row really is there, so the absence above is not an empty result.
    expect(JSON.stringify(bodies[3])).toContain('"status":"pending"');
  });
});

describe('dashboard read API: the live log', () => {
  it('WHEN a command was answered inline THE SYSTEM SHALL show its action and no job', async () => {
    await db().query(
      `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, command_name, status)
       VALUES ('900000000000000401', $1, '900000000000000002', '900000000000000003', 2, 'status', 'answered')`,
      [GUILD_A],
    );
    await db().query(
      `INSERT INTO action (interaction_id, guild_id, type, mirror_status)
       VALUES ('900000000000000401', $1, 'status', 'skipped')`,
      [GUILD_A],
    );

    const res = await kit.get(adminA, `/api/guilds/${GUILD_A}/interactions`);

    expect(pageOf(res.body).items).toMatchObject([
      {
        id: '900000000000000401',
        command: 'status',
        userId: '900000000000000003',
        interactionStatus: 'answered',
        action: { type: 'status', mirrorStatus: 'skipped', llmTag: null },
        job: null,
      },
    ]);
  });

  it('WHEN the log has more rows than a page THE SYSTEM SHALL page newest first with no duplicate and no gap even as new rows arrive mid-paging', async () => {
    // 25 rows inside ONE millisecond, with timestamp ties, so only a microsecond cursor plus the id tiebreaker is correct.
    const original: { id: string; micros: number }[] = [];
    for (let n = 0; n < 25; n += 1) {
      const row = {
        id: (900000000000000500n + BigInt(n)).toString(),
        micros: Math.floor(n / 2) * 10,
      };
      original.push(row);
      await insertRow(db(), {
        id: row.id,
        guildId: GUILD_A,
        createdAt: `2026-10-11T15:30:00.000${String(row.micros).padStart(3, '0')}Z`,
      });
    }
    const expected = [...original]
      .sort((x, y) => y.micros - x.micros || (x.id < y.id ? 1 : -1))
      .map((row) => row.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? 'limit=10' : `limit=10&cursor=${cursor}`;
      const page = pageOf(
        (await kit.get(adminA, `/api/guilds/${GUILD_A}/interactions?${query}`)).body,
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
      if (pages === 1) {
        for (const id of ['900000000000000601', '900000000000000602', '900000000000000603']) {
          await insertRow(db(), { id, guildId: GUILD_A, createdAt: '2026-10-11T16:00:00.000000Z' });
        }
      }
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(25);
    // The newer rows are not lost: the next poll of page 1 shows them on top.
    const poll = pageOf(
      (await kit.get(adminA, `/api/guilds/${GUILD_A}/interactions?limit=10`)).body,
    );
    expect(poll.items.slice(0, 3).map((item) => item.id)).toEqual([
      '900000000000000603',
      '900000000000000602',
      '900000000000000601',
    ]);
  });

  it('WHEN no page size is given THE SYSTEM SHALL return the default, and WHEN a larger one is asked for THE SYSTEM SHALL refuse it', async () => {
    await bulkRows(db(), GUILD_A, LOG_PAGE_SIZE_MAX + 20);
    const path = `/api/guilds/${GUILD_A}/interactions`;

    const byDefault = pageOf((await kit.get(adminA, path)).body);
    const atCap = pageOf(
      (await kit.get(adminA, `${path}?limit=${String(LOG_PAGE_SIZE_MAX)}`)).body,
    );
    const overCap = await kit.get(adminA, `${path}?limit=${String(LOG_PAGE_SIZE_MAX + 1)}`);

    expect(byDefault.items).toHaveLength(LOG_PAGE_SIZE_DEFAULT);
    expect(byDefault.nextCursor).not.toBeNull();
    expect(atCap.items).toHaveLength(LOG_PAGE_SIZE_MAX);
    expect(overCap.status).toBe(400);
    expect((overCap.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['a cursor that is junk', 'cursor=not-a-cursor'],
    [
      'a cursor with SQL in it',
      `cursor=${Buffer.from(JSON.stringify({ t: "';--", i: '1' })).toString('base64url')}`,
    ],
    ['an unknown job status', 'status=exploded'],
    ['an unknown parameter', 'after=1'],
    ['a limit of zero', 'limit=0'],
  ])(
    'WHEN the query has %s THE SYSTEM SHALL answer 400 VALIDATION_FAILED',
    async (_name, query) => {
      const res = await kit.get(adminA, `/api/guilds/${GUILD_A}/interactions?${query}`);

      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    },
  );

  it("WHEN a cursor from one server is used on another THE SYSTEM SHALL only ever return the second server's rows", async () => {
    await insertRow(db(), { id: '900000000000000701', guildId: GUILD_A });
    await insertRow(db(), { id: '900000000000000702', guildId: GUILD_A });
    await insertRow(db(), { id: '900000000000000703', guildId: GUILD_B });
    const first = pageOf(
      (await kit.get(adminA, `/api/guilds/${GUILD_A}/interactions?limit=1`)).body,
    );

    const res = await kit.get(
      adminB,
      `/api/guilds/${GUILD_B}/interactions?cursor=${first.nextCursor ?? ''}`,
    );

    expect(res.status).toBe(200);
    expect(pageOf(res.body).items.every((item) => item.id === '900000000000000703')).toBe(true);
  });
});

describe('dashboard read API: commands run through the real worker', () => {
  const asAdmin = async (): Promise<Admin> => {
    const admin = await kit.signIn('worker@example.test');
    await kit.manage(admin, GUILD_ID);
    return admin;
  };
  const detailPath = `/api/guilds/${GUILD_ID}/interactions/${INTERACTION_ID}`;

  it('WHEN the mirror fails fatally but the user still got a reply THE SYSTEM SHALL list the command under status=dead as followed_up with a readable reason', async () => {
    const h = pipeline();
    h.slack.behave(() => ({ status: 404, body: 'no_service' }));
    await seedReport(db(), h);
    await h.drain();
    h.clock.advance(60_000);
    await h.drain();
    const admin = await asAdmin();

    const dead = pageOf(
      (await kit.get(admin, `/api/guilds/${GUILD_ID}/interactions?status=dead`)).body,
    );
    const done = pageOf(
      (await kit.get(admin, `/api/guilds/${GUILD_ID}/interactions?status=done`)).body,
    );

    expect(dead.items).toMatchObject([
      {
        id: INTERACTION_ID,
        command: 'report',
        interactionStatus: 'followed_up',
        action: { type: 'report', mirrorStatus: 'failed' },
        job: {
          status: 'dead',
          attempts: 1,
          lastError:
            'Slack says the webhook no longer exists (HTTP 404). Set a new webhook URL on the dashboard.',
        },
      },
    ]);
    expect(done.items).toEqual([]);
  });

  it('WHEN Slack returns 500 then 200 THE SYSTEM SHALL show the command, its action and every attempt to the managing admin', async () => {
    const h = pipeline();
    h.slack.behave(thenOk(500));
    await seedReport(db(), h);
    await h.drain();
    h.clock.advance(1000);
    await h.drain();
    const admin = await asAdmin();

    const res = await kit.get(admin, detailPath);

    expect(res.status).toBe(200);
    const detail = InteractionDetail.parse(res.body);
    expect(detail).toMatchObject({
      id: INTERACTION_ID,
      interactionStatus: 'followed_up',
      action: { type: 'report', mirrorStatus: 'sent' },
      job: { status: 'done', lastError: null },
    });
    expect(
      detail.attemptHistory.map(
        (a) => `${String(a.attemptNo)}:${a.target}:${a.outcome}:${String(a.httpStatus)}`,
      ),
    ).toEqual(['1:mirror:retryable:500', '2:mirror:success:200', '2:followup:success:200']);
    expect(detail.attemptHistory[0]?.error).toBe('Slack had a problem on its side (HTTP 500).');
    expect(detail.attemptHistory.every((a) => a.finishedAt !== null)).toBe(true);
  });

  it('WHEN Slack keeps failing until the attempts run out THE SYSTEM SHALL show every failed attempt and a dead job', async () => {
    const h = pipeline();
    h.slack.behave(() => ({ status: 500 }));
    await seedReport(db(), h);
    for (let pass = 0; pass < 8; pass += 1) {
      await h.drain();
      h.clock.advance(1000);
    }
    const admin = await asAdmin();

    const detail = InteractionDetail.parse((await kit.get(admin, detailPath)).body);

    expect(detail.job).toMatchObject({ status: 'dead', attempts: 8 });
    expect(detail.job?.lastError).toContain('Gave up after 8 attempts.');
    expect(detail.attemptHistory.filter((a) => a.target === 'mirror')).toHaveLength(8);
    expect(detail.attemptHistory.at(-1)).toMatchObject({ target: 'followup', outcome: 'success' });
  });

  it('WHEN a job is still pending with its token and webhook stored THE SYSTEM SHALL expose neither', async () => {
    const h = pipeline();
    await seedReport(db(), h);
    const admin = await asAdmin();
    const stored = await db().query<{ interaction_token: string }>(
      'SELECT interaction_token FROM job',
    );
    expect(stored.rows[0]?.interaction_token).toContain('fake-interaction-token');

    const list = await kit.get(admin, `/api/guilds/${GUILD_ID}/interactions`);
    const detail = await kit.get(admin, detailPath);

    for (const text of [list.text, detail.text]) {
      expect(text).not.toContain('fake-interaction-token');
      expect(text).not.toContain(WEBHOOK_SECRET);
    }
    expect(pageOf(list.body).items[0]?.job).toMatchObject({ status: 'pending' });
  });

  it('WHEN a stored failure reason contains a webhook link THE SYSTEM SHALL remove the link from the list and the attempt history', async () => {
    const h = pipeline();
    h.slack.behave(() => ({ status: 404 }));
    await seedReport(db(), h);
    await h.drain();
    h.clock.advance(60_000);
    await h.drain();
    const leak = `Slack failed at https://hooks.slack.com/services/T0/B0/${SENTINEL_WEBHOOK}`;
    // Deliberately corrupted after the real run: proves the mapper holds even if a future code path stores a URL.
    await db().query('UPDATE job SET last_error = $1', [leak]);
    await db().query('UPDATE job_attempt SET error = $1', [leak]);
    const admin = await asAdmin();

    const list = await kit.get(admin, `/api/guilds/${GUILD_ID}/interactions`);
    const detail = await kit.get(admin, detailPath);

    expect(list.text).not.toContain(SENTINEL_WEBHOOK);
    expect(detail.text).not.toContain(SENTINEL_WEBHOOK);
    expect(InteractionDetail.parse(detail.body).attemptHistory[0]?.error).toBe(
      'Slack failed at [link removed]',
    );
  });
});

describe('dashboard read API: when the database fails', () => {
  it('WHEN the tenant lookup cannot run THE SYSTEM SHALL answer a generic 500 and no data', async () => {
    await insertRow(db(), { id: '900000000000000801', guildId: GUILD_A });
    await db().query('ALTER TABLE admin_guild RENAME TO admin_guild_hidden');
    try {
      const res = await kit.get(adminA, `/api/guilds/${GUILD_A}/interactions`);

      expect(res.status).toBe(500);
      expect(res.text).not.toContain('admin_guild');
      expect(res.text).not.toContain('900000000000000801');
    } finally {
      await db().query('ALTER TABLE admin_guild_hidden RENAME TO admin_guild');
    }
  });
});
