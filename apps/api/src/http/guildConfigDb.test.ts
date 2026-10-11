import { DEFAULT_RULES, GuildSettings, RuleList, RuleView } from '@report-line/shared';
import type pg from 'pg';
import type { Response } from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { TEST_GUILD_CONFIG } from '../../test/helpers/authFakes.js';
import {
  makeDashboardKit,
  type Admin,
  type DashboardKit,
} from '../../test/helpers/dashboardKit.js';
import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import { AesGcmWebhookCipher } from '../adapters/aesGcmWebhookCipher.js';

const db = useTestDatabase();

const GUILD_A = '900000000000000101';
const GUILD_B = '900000000000000102';
const UNKNOWN_GUILD = '900000000000000199';
const FREE_GUILD = '900000000000000301';
const SENTINEL = 'SENTINEL-SECRET-7c2e';
const WEBHOOK = `https://hooks.slack.com/services/T000/B000/${SENTINEL}`;
const CHANNEL = '900000000000000555';
const CSRF_WRONG = 'not-the-token';

const settingsPath = (guildId: string): string => `/api/guilds/${guildId}/settings`;
const rulesPath = (guildId: string, command?: string): string =>
  command === undefined
    ? `/api/guilds/${guildId}/rules`
    : `/api/guilds/${guildId}/rules/${command}`;

const cipher = new AesGcmWebhookCipher(TEST_GUILD_CONFIG.WEBHOOK_ENC_KEY);

let kit: DashboardKit;
let adminA: Admin;
let adminB: Admin;

beforeEach(async () => {
  await truncateAll(db());
  kit = makeDashboardKit(db());
  adminA = await kit.signIn('a@example.test');
  adminB = await kit.signIn('b@example.test');
  await kit.manage(adminA, GUILD_A);
  await kit.manage(adminB, GUILD_B);
});

/** Everything a change could touch, as text, so "nothing was written" is one equality. */
async function snapshot(pool: pg.Pool): Promise<string> {
  const tables = ['guild', 'command_rule', 'admin_guild'];
  const dumps = await Promise.all(
    tables.map(async (table) =>
      JSON.stringify((await pool.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows),
    ),
  );
  return dumps.join('|');
}

/** The part of an error response that must not differ between "not yours" and "does not exist". */
function errorShape(res: Response): { status: number; code: unknown; message: unknown } {
  const body = res.body as { error?: { code?: unknown; message?: unknown } };
  return { status: res.status, code: body.error?.code, message: body.error?.message };
}

function fieldsOf(res: Response): unknown {
  return (res.body as { error?: { details?: { fields?: unknown } } }).error?.details?.fields;
}

function expectNoSecret(res: Response): void {
  expect(res.text).not.toContain(SENTINEL);
  expect(kit.logs.text()).not.toContain(SENTINEL);
}

describe('PUT /api/guilds/:guildId/settings', () => {
  it('WHEN there is no session THE SYSTEM SHALL answer 401 and write nothing', async () => {
    const before = await snapshot(db());
    const res = await kit.send('put', undefined, settingsPath(GUILD_A), { postChannelId: CHANNEL });
    expect(res.status).toBe(401);
    expect(await snapshot(db())).toBe(before);
  });

  it.each([
    ['no CSRF token', null],
    ['a wrong CSRF token', CSRF_WRONG],
  ])(
    'WHEN the request has %s THE SYSTEM SHALL answer 403 and write nothing',
    async (_name, csrf) => {
      const before = await snapshot(db());
      const res = await kit.send(
        'put',
        adminA,
        settingsPath(GUILD_A),
        { postChannelId: CHANNEL },
        csrf,
      );
      expect(res.status).toBe(403);
      expect(errorShape(res).code).toBe('CSRF_REJECTED');
      expect(await snapshot(db())).toBe(before);
    },
  );

  it('WHEN admin A changes a server only B manages THE SYSTEM SHALL answer the same 404 as for an unknown server and write nothing', async () => {
    const before = await snapshot(db());
    const body = { postChannelId: CHANNEL, mirrorWebhookUrl: WEBHOOK };

    const foreign = await kit.send('put', adminA, settingsPath(GUILD_B), body);
    const unknown = await kit.send('put', adminA, settingsPath(UNKNOWN_GUILD), body);

    expect(foreign.status).toBe(404);
    expect(errorShape(foreign)).toEqual(errorShape(unknown));
    expect(await snapshot(db())).toBe(before);
    expectNoSecret(foreign);
  });

  it('WHEN a valid channel and webhook are saved THE SYSTEM SHALL answer only the safe shape and store the webhook encrypted', async () => {
    const res = await kit.send('put', adminA, settingsPath(GUILD_A), {
      postChannelId: CHANNEL,
      mirrorWebhookUrl: WEBHOOK,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ postChannelId: CHANNEL, mirrorConfigured: true });
    expect(GuildSettings.safeParse(res.body).success).toBe(true);
    const stored = await db().query<{ mirror_webhook_enc: Buffer; post_channel_id: string }>(
      'SELECT mirror_webhook_enc, post_channel_id FROM guild WHERE id = $1',
      [GUILD_A],
    );
    const blob = stored.rows[0]?.mirror_webhook_enc;
    expect(blob?.includes(Buffer.from(SENTINEL))).toBe(false);
    expect(blob === undefined ? '' : cipher.decrypt(blob, GUILD_A)).toBe(WEBHOOK);
    expect(stored.rows[0]?.post_channel_id).toBe(CHANNEL);
    expectNoSecret(res);
  });

  it('WHEN the settings are read back THE SYSTEM SHALL answer the same safe shape and never the webhook', async () => {
    await kit.send('put', adminA, settingsPath(GUILD_A), { mirrorWebhookUrl: WEBHOOK });

    const res = await kit.get(adminA, settingsPath(GUILD_A));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ postChannelId: null, mirrorConfigured: true });
    expectNoSecret(res);
  });

  it('WHEN only the channel is sent THE SYSTEM SHALL leave the webhook alone', async () => {
    await kit.send('put', adminA, settingsPath(GUILD_A), { mirrorWebhookUrl: WEBHOOK });

    const res = await kit.send('put', adminA, settingsPath(GUILD_A), { postChannelId: CHANNEL });

    expect(res.body).toEqual({ postChannelId: CHANNEL, mirrorConfigured: true });
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['blanks only', '   '],
  ])(
    'WHEN the webhook is sent as %s THE SYSTEM SHALL clear it explicitly',
    async (_name, value) => {
      await kit.send('put', adminA, settingsPath(GUILD_A), {
        postChannelId: CHANNEL,
        mirrorWebhookUrl: WEBHOOK,
      });

      const res = await kit.send('put', adminA, settingsPath(GUILD_A), { mirrorWebhookUrl: value });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ postChannelId: CHANNEL, mirrorConfigured: false });
      const cleared = await db().query(
        'SELECT 1 FROM guild WHERE id = $1 AND mirror_webhook_enc IS NULL',
        [GUILD_A],
      );
      expect(cleared.rowCount).toBe(1);
    },
  );

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('WHEN the channel is sent as %s THE SYSTEM SHALL clear it', async (_name, value) => {
    await kit.send('put', adminA, settingsPath(GUILD_A), { postChannelId: CHANNEL });

    const res = await kit.send('put', adminA, settingsPath(GUILD_A), { postChannelId: value });

    expect(res.body).toEqual({ postChannelId: null, mirrorConfigured: false });
  });

  it.each([
    ['plain http', `http://hooks.slack.com/services/T000/B000/${SENTINEL}`],
    ['an IPv4 literal', `https://169.254.169.254/services/T000/B000/${SENTINEL}`],
    ['an IPv6 literal', `https://[::1]/services/T000/B000/${SENTINEL}`],
    ['localhost', `https://localhost/services/T000/B000/${SENTINEL}`],
    ['another host', `https://example.test/services/T000/B000/${SENTINEL}`],
    ['a look-alike host', `https://hooks.slack.com.evil.test/services/T000/B000/${SENTINEL}`],
    ['userinfo that hides the real host', `https://hooks.slack.com@evil.test/services/${SENTINEL}`],
    ['credentials in the URL', `https://user:${SENTINEL}@hooks.slack.com/services/T000/B000/x`],
    ['another path on the host', `https://hooks.slack.com/other/${SENTINEL}`],
    ['a space inside', `https://hooks.slack.com/services/T000/B000/${SENTINEL} x`],
    ['text that is not a URL', SENTINEL],
    ['a URL longer than the limit', `${WEBHOOK}/${'a'.repeat(600)}`],
  ])(
    'WHEN the webhook is %s THE SYSTEM SHALL answer 400 with the field name, echo nothing and write nothing',
    async (_name, url) => {
      await kit.send('put', adminA, settingsPath(GUILD_A), { mirrorWebhookUrl: WEBHOOK });
      const before = await snapshot(db());

      const res = await kit.send('put', adminA, settingsPath(GUILD_A), { mirrorWebhookUrl: url });

      expect(res.status).toBe(400);
      expect(errorShape(res).code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res)).toEqual(['mirrorWebhookUrl']);
      expect(res.text).not.toContain('evil.test');
      expect(res.text).not.toContain('169.254');
      expectNoSecret(res);
      expect(await snapshot(db())).toBe(before);
    },
  );

  it.each([
    ['an empty body', {}, ['(root)']],
    ['an unknown key', { postChannelId: CHANNEL, [`role${SENTINEL}`]: 1 }, ['(root)']],
    ['a channel that is not an id', { postChannelId: `x${SENTINEL}` }, ['postChannelId']],
    ['a webhook of the wrong type', { mirrorWebhookUrl: 42 }, ['mirrorWebhookUrl']],
  ])(
    'WHEN the body is %s THE SYSTEM SHALL answer 400 with field paths only',
    async (_name, body, fields) => {
      const before = await snapshot(db());

      const res = await kit.send('put', adminA, settingsPath(GUILD_A), body);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(fields);
      expectNoSecret(res);
      expect(await snapshot(db())).toBe(before);
    },
  );

  it('WHEN settings change or are refused THE SYSTEM SHALL log security events with ids and setting names only', async () => {
    await kit.send('put', adminA, settingsPath(GUILD_A), {
      postChannelId: CHANNEL,
      mirrorWebhookUrl: WEBHOOK,
    });
    await kit.send('put', adminA, settingsPath(GUILD_A), { mirrorWebhookUrl: 'http://evil.test/' });

    const events = kit.logs.records().filter((r) => r.logType === 'security');
    expect(events.find((r) => r.event === 'config.settings.updated')).toMatchObject({
      result: 'success',
      adminId: adminA.id,
      guildId: GUILD_A,
      changed: ['postChannelId', 'mirrorWebhookUrl'],
    });
    expect(events.find((r) => r.event === 'config.settings.rejected')).toMatchObject({
      result: 'failed',
      reason: 'validation_failed',
      guildId: GUILD_A,
      fields: ['mirrorWebhookUrl'],
    });
    expect(kit.logs.text()).not.toContain('evil.test');
    expect(kit.logs.text()).not.toContain(SENTINEL);
  });
});

describe('GET /api/guilds/:guildId/settings', () => {
  it('WHEN there is no session THE SYSTEM SHALL answer 401', async () => {
    expect((await kit.get(undefined, settingsPath(GUILD_A))).status).toBe(401);
  });

  it('WHEN admin A reads a server only B manages THE SYSTEM SHALL answer the same 404 as for an unknown server', async () => {
    const foreign = await kit.get(adminA, settingsPath(GUILD_B));
    const unknown = await kit.get(adminA, settingsPath(UNKNOWN_GUILD));
    expect(foreign.status).toBe(404);
    expect(errorShape(foreign)).toEqual(errorShape(unknown));
  });

  it('WHEN nothing is set yet THE SYSTEM SHALL answer null and false', async () => {
    const res = await kit.get(adminA, settingsPath(GUILD_A));
    expect(res.body).toEqual({ postChannelId: null, mirrorConfigured: false });
  });
});

describe('rules', () => {
  const reportRule = {
    enabled: true,
    config: { version: 1, ephemeral: false, replyMessage: '  Got it.  ', mirror: false, tag: true },
  };

  it('WHEN a server has saved nothing THE SYSTEM SHALL list every command with its default and customised false', async () => {
    const res = await kit.get(adminA, rulesPath(GUILD_A));

    expect(res.status).toBe(200);
    expect(RuleList.safeParse(res.body).success).toBe(true);
    expect(res.body).toEqual({
      items: [
        { command: 'status', enabled: true, customised: false, config: DEFAULT_RULES.status },
        { command: 'report', enabled: true, customised: false, config: DEFAULT_RULES.report },
      ],
    });
  });

  it('WHEN a valid rule is saved THE SYSTEM SHALL store the parsed config and list it as customised', async () => {
    const saved = await kit.send('put', adminA, rulesPath(GUILD_A, 'report'), reportRule);

    expect(saved.status).toBe(200);
    expect(RuleView.safeParse(saved.body).success).toBe(true);
    expect(saved.body).toEqual({
      command: 'report',
      enabled: true,
      customised: true,
      config: { ...reportRule.config, replyMessage: 'Got it.' },
    });
    const row = await db().query('SELECT config, enabled FROM command_rule WHERE guild_id = $1', [
      GUILD_A,
    ]);
    expect(row.rows).toEqual([{ config: (saved.body as RuleView).config, enabled: true }]);
    const listed = await kit.get(adminA, rulesPath(GUILD_A));
    expect((listed.body as RuleList).items[1]).toEqual(saved.body);
  });

  it('WHEN a rule is saved twice THE SYSTEM SHALL keep one row holding the latest', async () => {
    await kit.send('put', adminA, rulesPath(GUILD_A, 'status'), {
      enabled: true,
      config: { version: 1, ephemeral: true },
    });
    const second = await kit.send('put', adminA, rulesPath(GUILD_A, 'status'), {
      enabled: false,
      config: { version: 1, ephemeral: false },
    });

    expect(second.body).toEqual({
      command: 'status',
      enabled: false,
      customised: true,
      config: { version: 1, ephemeral: false },
    });
    const rows = await db().query('SELECT 1 FROM command_rule WHERE guild_id = $1', [GUILD_A]);
    expect(rows.rowCount).toBe(1);
  });

  it('WHEN a rule is saved THE SYSTEM SHALL leave jobs already enqueued with their own snapshot', async () => {
    const pool = db();
    await pool.query(
      `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, command_name, status)
       VALUES ('900000000000000700', $1, '900000000000000002', '900000000000000003', 2, 'report', 'deferred')`,
      [GUILD_A],
    );
    const payload = { reply: { message: 'Old text', ephemeral: true } };
    await pool.query(
      `INSERT INTO job (interaction_id, guild_id, kind, payload) VALUES ('900000000000000700', $1, 'report', $2)`,
      [GUILD_A, JSON.stringify(payload)],
    );

    await kit.send('put', adminA, rulesPath(GUILD_A, 'report'), reportRule);

    expect((await pool.query('SELECT payload FROM job')).rows).toEqual([{ payload }]);
  });

  it('WHEN a stored rule no longer validates THE SYSTEM SHALL still list the command, with its default', async () => {
    await db().query(
      `INSERT INTO command_rule (guild_id, command_name, config, enabled) VALUES ($1, 'report', '{"version":9}', false)`,
      [GUILD_A],
    );

    const res = await kit.get(adminA, rulesPath(GUILD_A));

    expect((res.body as RuleList).items[1]).toEqual({
      command: 'report',
      enabled: false,
      customised: false,
      config: DEFAULT_RULES.report,
    });
  });

  it.each([
    [
      'text that is too long',
      { ...reportRule.config, replyMessage: `${SENTINEL}${'x'.repeat(300)}` },
      ['config.replyMessage'],
    ],
    ['an unknown key', { ...reportRule.config, [`extra${SENTINEL}`]: 1 }, ['config']],
    ['a wrong type', { ...reportRule.config, mirror: SENTINEL }, ['config.mirror']],
    [
      'a missing field',
      { version: 1, ephemeral: true },
      ['config.replyMessage', 'config.mirror', 'config.tag'],
    ],
    ['a value that is not an object', SENTINEL, ['config']],
    ['no value at all', undefined, ['config']],
  ])(
    'WHEN the config is %s THE SYSTEM SHALL answer 400 with field paths and write nothing',
    async (_name, config, fields) => {
      const before = await snapshot(db());

      const res = await kit.send('put', adminA, rulesPath(GUILD_A, 'report'), {
        enabled: true,
        config,
      });

      expect(res.status).toBe(400);
      expect(errorShape(res).code).toBe('VALIDATION_FAILED');
      expect(fieldsOf(res)).toEqual(fields);
      expectNoSecret(res);
      expect(await snapshot(db())).toBe(before);
    },
  );

  it.each([
    ['a missing enabled flag', { config: DEFAULT_RULES.status }, ['enabled']],
    [
      'an unknown key',
      { enabled: true, config: DEFAULT_RULES.status, admin: SENTINEL },
      ['(root)'],
    ],
  ])(
    'WHEN the body has %s THE SYSTEM SHALL answer 400 with field paths only',
    async (_name, body, fields) => {
      const res = await kit.send('put', adminA, rulesPath(GUILD_A, 'status'), body);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(fields);
      expectNoSecret(res);
    },
  );

  it.each([
    ['an unknown command', 'nope'],
    ['a prototype name', '__proto__'],
    ['the wrong letter case', 'Report'],
  ])(
    'WHEN the command is %s THE SYSTEM SHALL answer 400 naming the command field and write nothing',
    async (_name, command) => {
      const before = await snapshot(db());

      const res = await kit.send('put', adminA, rulesPath(GUILD_A, command), reportRule);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(['command']);
      expect(await snapshot(db())).toBe(before);
    },
  );

  it('WHEN there is no session THE SYSTEM SHALL answer 401 for both reading and saving', async () => {
    expect((await kit.get(undefined, rulesPath(GUILD_A))).status).toBe(401);
    const save = await kit.send('put', undefined, rulesPath(GUILD_A, 'report'), reportRule);
    expect(save.status).toBe(401);
  });

  it.each([
    ['no CSRF token', null],
    ['a wrong CSRF token', CSRF_WRONG],
  ])('WHEN a save has %s THE SYSTEM SHALL answer 403 and write nothing', async (_name, csrf) => {
    const before = await snapshot(db());
    const res = await kit.send('put', adminA, rulesPath(GUILD_A, 'report'), reportRule, csrf);
    expect(res.status).toBe(403);
    expect(await snapshot(db())).toBe(before);
  });

  it('WHEN admin A reads or saves the rules of a server only B manages THE SYSTEM SHALL answer the same 404 as for an unknown server and write nothing', async () => {
    const before = await snapshot(db());

    const listed = await kit.get(adminA, rulesPath(GUILD_B));
    const saved = await kit.send('put', adminA, rulesPath(GUILD_B, 'report'), reportRule);
    const unknown = await kit.send('put', adminA, rulesPath(UNKNOWN_GUILD, 'report'), reportRule);

    expect(listed.status).toBe(404);
    expect(saved.status).toBe(404);
    expect(errorShape(saved)).toEqual(errorShape(unknown));
    expect(await snapshot(db())).toBe(before);
  });

  it('WHEN a rule is saved THE SYSTEM SHALL log a security event with the command and ids only', async () => {
    await kit.send('put', adminA, rulesPath(GUILD_A, 'report'), reportRule);

    expect(kit.logs.records().find((r) => r.event === 'config.rule.updated')).toMatchObject({
      logType: 'security',
      result: 'success',
      adminId: adminA.id,
      guildId: GUILD_A,
      command: 'report',
    });
    expect(kit.logs.text()).not.toContain('Got it.');
  });
});

describe('POST /api/guilds (connect a server)', () => {
  const connect = (admin: Admin | undefined, body: unknown, csrf?: string | null) =>
    kit.send('post', admin, '/api/guilds', body, csrf);

  async function seenGuild(id: string): Promise<void> {
    await db().query('INSERT INTO guild (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      id,
      'Test server',
    ]);
  }

  async function owners(guildId: string): Promise<string[]> {
    const rows = await db().query<{ admin_id: string }>(
      'SELECT admin_id FROM admin_guild WHERE guild_id = $1',
      [guildId],
    );
    return rows.rows.map((row) => row.admin_id);
  }

  it('WHEN there is no session THE SYSTEM SHALL answer 401 and claim nothing', async () => {
    await seenGuild(FREE_GUILD);
    expect((await connect(undefined, { guildId: FREE_GUILD })).status).toBe(401);
    expect(await owners(FREE_GUILD)).toEqual([]);
  });

  it.each([
    ['no CSRF token', null],
    ['a wrong CSRF token', CSRF_WRONG],
  ])(
    'WHEN the request has %s THE SYSTEM SHALL answer 403 and claim nothing',
    async (_name, csrf) => {
      await seenGuild(FREE_GUILD);
      const res = await connect(adminA, { guildId: FREE_GUILD }, csrf);
      expect(res.status).toBe(403);
      expect(await owners(FREE_GUILD)).toEqual([]);
    },
  );

  it('WHEN an admin connects a server the bot has seen and nobody manages THE SYSTEM SHALL link it and list it', async () => {
    await seenGuild(FREE_GUILD);
    const c = await kit.signIn('c@example.test');

    const res = await connect(c, { guildId: FREE_GUILD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: FREE_GUILD, name: 'Test server' });
    expect(await owners(FREE_GUILD)).toEqual([c.id]);
    expect((await kit.get(c, '/api/guilds')).body).toEqual({
      items: [{ id: FREE_GUILD, name: 'Test server' }],
    });
    expect((await kit.get(c, settingsPath(FREE_GUILD))).status).toBe(200);
    expect(kit.logs.records().find((r) => r.event === 'guild.connected')).toMatchObject({
      logType: 'security',
      result: 'success',
      adminId: c.id,
      guildId: FREE_GUILD,
    });
  });

  it('WHEN the same admin connects the same server again THE SYSTEM SHALL answer 200 and keep one link', async () => {
    await seenGuild(FREE_GUILD);
    const c = await kit.signIn('c@example.test');
    await connect(c, { guildId: FREE_GUILD });

    const again = await connect(c, { guildId: FREE_GUILD });

    expect(again.status).toBe(200);
    expect(await owners(FREE_GUILD)).toEqual([c.id]);
  });

  it('WHEN a second admin connects a server the first already manages THE SYSTEM SHALL answer the same 404 as for an unknown server and add no link', async () => {
    await seenGuild(FREE_GUILD);
    const c = await kit.signIn('c@example.test');
    await connect(c, { guildId: FREE_GUILD });

    const taken = await connect(adminA, { guildId: FREE_GUILD });
    const unknown = await connect(adminA, { guildId: UNKNOWN_GUILD });

    expect(taken.status).toBe(404);
    expect(errorShape(taken)).toEqual(errorShape(unknown));
    expect(await owners(FREE_GUILD)).toEqual([c.id]);
    expect((await kit.get(adminA, settingsPath(FREE_GUILD))).status).toBe(404);
  });

  it('WHEN another admin connects a server already linked outside this flow THE SYSTEM SHALL not move it', async () => {
    const taken = await connect(adminB, { guildId: GUILD_A });

    expect(taken.status).toBe(404);
    expect(await owners(GUILD_A)).toEqual([adminA.id]);
  });

  it('WHEN the server does not exist THE SYSTEM SHALL answer 404, create nothing and log the refusal', async () => {
    const res = await connect(adminA, { guildId: UNKNOWN_GUILD });

    expect(res.status).toBe(404);
    const created = await db().query('SELECT 1 FROM guild WHERE id = $1', [UNKNOWN_GUILD]);
    expect(created.rowCount).toBe(0);
    expect(kit.logs.records().find((r) => r.event === 'guild.connect.denied')).toMatchObject({
      logType: 'security',
      result: 'failed',
      adminId: adminA.id,
    });
  });

  it.each([
    ['an id that is not an id', { guildId: `x${SENTINEL}` }, ['guildId']],
    ['no id', {}, ['guildId']],
    ['an unknown key', { guildId: FREE_GUILD, [`admin${SENTINEL}`]: 1 }, ['(root)']],
  ])(
    'WHEN the body has %s THE SYSTEM SHALL answer 400 with field paths only',
    async (_name, body, fields) => {
      await seenGuild(FREE_GUILD);

      const res = await connect(adminA, body);

      expect(res.status).toBe(400);
      expect(fieldsOf(res)).toEqual(fields);
      expectNoSecret(res);
      expect(await owners(FREE_GUILD)).toEqual([]);
    },
  );

  it('WHEN two admins connect the same server at the same moment THE SYSTEM SHALL let exactly one win', async () => {
    const c = await kit.signIn('c@example.test');
    const d = await kit.signIn('d@example.test');
    await seenGuild(FREE_GUILD);
    const callers = [c, d, c, d, c, d, c, d];

    const results = await Promise.all(
      callers.map((admin) => connect(admin, { guildId: FREE_GUILD })),
    );

    const owner = await owners(FREE_GUILD);
    expect(owner).toHaveLength(1);
    const winner = owner[0] === c.id ? c : d;
    expect(results.map((res) => res.status)).toEqual(
      callers.map((admin) => (admin === winner ? 200 : 404)),
    );
  });
});
