import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { truncateAll, useTestDatabase } from '../../../test/helpers/db.js';
import { InvalidCursorError } from '../../ports/dashboard.js';
import { PgDashboardReader } from './pgDashboardReader.js';

const db = useTestDatabase();

const GUILD_A = '900000000000000101';
const GUILD_B = '900000000000000102';
const ROW_A = '900000000000000201';
const ROW_B = '900000000000000202';

let adminA: string;
let adminB: string;

async function addAdmin(email: string, guildId: string): Promise<string> {
  const id = randomUUID();
  await db().query('INSERT INTO admin (id, email, password_hash) VALUES ($1, $2, $3)', [
    id,
    email,
    'hash',
  ]);
  await db().query('INSERT INTO guild (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [guildId]);
  await db().query('INSERT INTO admin_guild (admin_id, guild_id) VALUES ($1, $2)', [id, guildId]);
  return id;
}

async function addCommand(id: string, guildId: string): Promise<void> {
  await db().query(
    `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, command_name, status)
     VALUES ($1, $2, '900000000000000002', '900000000000000003', 2, 'report', 'deferred')`,
    [id, guildId],
  );
  await db().query(
    `INSERT INTO action (interaction_id, guild_id, type, mirror_status) VALUES ($1, $2, 'report', 'pending')`,
    [id, guildId],
  );
}

beforeEach(async () => {
  await truncateAll(db());
  adminA = await addAdmin('a@example.test', GUILD_A);
  adminB = await addAdmin('b@example.test', GUILD_B);
  await addCommand(ROW_A, GUILD_A);
  await addCommand(ROW_B, GUILD_B);
});

describe('PgDashboardReader: a cursor the database refuses', () => {
  it.each([
    '2026-13-45T25:61:61.000000Z',
    '0000-01-01T00:00:00.000000Z',
    '2026-02-30T00:00:00.000000Z',
  ])(
    'WHEN the cursor timestamp %s reaches the cast THE SYSTEM SHALL reject with InvalidCursorError, not a raw pg error',
    async (at) => {
      const reader = new PgDashboardReader(db());

      await expect(
        reader.listInteractions(adminA, GUILD_A, { limit: 10, after: { at, id: ROW_A } }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
    },
  );
});

// The TenantGuard middleware is the first lock. These prove the SQL is a second one: a route that forgot
// the guard would still get nothing for a guild the admin does not manage.
describe('PgDashboardReader: the query itself enforces the tenant', () => {
  it('WHEN the admin does not manage the guild THE SYSTEM SHALL return no rows from the list', async () => {
    const reader = new PgDashboardReader(db());

    expect(await reader.listInteractions(adminA, GUILD_B, { limit: 10 })).toEqual([]);
    expect(
      (await reader.listInteractions(adminA, GUILD_A, { limit: 10 })).map((row) => row.id),
    ).toEqual([ROW_A]);
  });

  it('WHEN the admin does not manage the guild THE SYSTEM SHALL find no command and no attempts', async () => {
    const reader = new PgDashboardReader(db());

    expect(await reader.findInteraction(adminA, GUILD_B, ROW_B)).toBeUndefined();
    expect(await reader.findInteraction(adminA, GUILD_A, ROW_B)).toBeUndefined();
    expect((await reader.findInteraction(adminB, GUILD_B, ROW_B))?.row.id).toBe(ROW_B);
  });

  it('WHEN the admin does not manage the guild THE SYSTEM SHALL say so', async () => {
    const reader = new PgDashboardReader(db());

    expect(await reader.managesGuild(adminA, GUILD_A)).toBe(true);
    expect(await reader.managesGuild(adminA, GUILD_B)).toBe(false);
    expect(await reader.managesGuild(adminA, '900000000000000199')).toBe(false);
  });

  it("WHEN servers are listed THE SYSTEM SHALL return only the admin's own, named ones first", async () => {
    await db().query("UPDATE guild SET name = 'Zeta' WHERE id = $1", [GUILD_A]);
    const second = '900000000000000103';
    await db().query('INSERT INTO guild (id, name) VALUES ($1, $2)', [second, 'Alpha']);
    await db().query('INSERT INTO admin_guild (admin_id, guild_id) VALUES ($1, $2)', [
      adminA,
      second,
    ]);

    const rows = await new PgDashboardReader(db()).listGuilds(adminA);

    expect(rows).toEqual([
      { id: second, name: 'Alpha' },
      { id: GUILD_A, name: 'Zeta' },
    ]);
  });
});
