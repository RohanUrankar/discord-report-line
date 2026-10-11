import { execFile } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { testDatabaseUrl, truncateAll, useTestDatabase } from '../../../test/helpers/db.js';
import { AesGcmWebhookCipher } from '../aesGcmWebhookCipher.js';
import { PgMirrorWebhookStore } from './pgMirrorWebhookStore.js';

const db = useTestDatabase();

const GUILD = '900000000000000001';
const KEY = Buffer.alloc(32, 6).toString('base64');
const PREFIX = 'https://hooks.slack.com/services/';
const URL_OK = `${PREFIX}T000/B000/fake-secret-do-not-leak`;
const SCRIPT = path.resolve(import.meta.dirname, '../../../../../scripts/set-mirror-webhook.ts');
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../../..');

describe('PgMirrorWebhookStore', () => {
  it('WHEN the server has no row yet THE SYSTEM SHALL create it with the webhook', async () => {
    const pool = db();
    await truncateAll(pool);

    await new PgMirrorWebhookStore(pool).save(GUILD, Buffer.from('blob-1'));

    const rows = await pool.query('SELECT id, mirror_webhook_enc FROM guild');
    expect(rows.rows).toEqual([{ id: GUILD, mirror_webhook_enc: Buffer.from('blob-1') }]);
  });

  it('WHEN a webhook is already set THE SYSTEM SHALL replace it and keep the server’s other settings', async () => {
    const pool = db();
    await truncateAll(pool);
    await pool.query(
      "INSERT INTO guild (id, name, post_channel_id) VALUES ($1, 'My server', '5')",
      [GUILD],
    );
    const store = new PgMirrorWebhookStore(pool);

    await store.save(GUILD, Buffer.from('blob-1'));
    await store.save(GUILD, Buffer.from('blob-2'));

    const rows = await pool.query('SELECT name, post_channel_id, mirror_webhook_enc FROM guild');
    expect(rows.rows).toEqual([
      { name: 'My server', post_channel_id: '5', mirror_webhook_enc: Buffer.from('blob-2') },
    ]);
  });
});

describe('scripts/set-mirror-webhook.ts', () => {
  const runScript = async (
    args: string[],
    stdinText: string,
    extraEnv: Record<string, string> = {},
  ) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        ['--import', 'tsx', SCRIPT, ...args],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DATABASE_URL: testDatabaseUrl(),
            WEBHOOK_ENC_KEY: KEY,
            ...extraEnv,
          },
        },
        (error, stdout, stderr) => {
          resolve({
            code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
            stdout,
            stderr,
          });
        },
      );
      child.stdin?.end(stdinText);
    });

  it('WHEN given a Slack URL on standard input THE SYSTEM SHALL store it encrypted and print only its last four characters', async () => {
    const pool = db();
    await truncateAll(pool);

    const result = await runScript([GUILD], `${URL_OK}\n`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`ends in leak`);
    expect(result.stdout + result.stderr).not.toContain('fake-secret');
    const rows = await pool.query<{ mirror_webhook_enc: Buffer }>(
      'SELECT mirror_webhook_enc FROM guild',
    );
    const blob = rows.rows[0]?.mirror_webhook_enc;
    expect(blob).toBeDefined();
    expect(new AesGcmWebhookCipher(KEY).decrypt(blob ?? Buffer.alloc(0), GUILD)).toBe(URL_OK);
  });

  it('WHEN the URL is not a Slack webhook THE SYSTEM SHALL refuse, store nothing and not echo it', async () => {
    const pool = db();
    await truncateAll(pool);

    const result = await runScript([GUILD], 'https://evil.example/services/T/B/secret-part');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not a Slack webhook URL');
    expect(result.stdout + result.stderr).not.toContain('evil.example');
    expect((await pool.query('SELECT 1 FROM guild')).rows).toEqual([]);
  });

  it('WHEN the server id is missing or not a snowflake THE SYSTEM SHALL print usage and store nothing', async () => {
    const pool = db();
    await truncateAll(pool);

    const none = await runScript([], URL_OK);
    const bad = await runScript(['my-server'], URL_OK);

    expect(none.code).toBe(1);
    expect(bad.code).toBe(1);
    expect(none.stderr).toContain('Usage');
    expect((await pool.query('SELECT 1 FROM guild')).rows).toEqual([]);
  });

  it('WHEN WEBHOOK_ENC_KEY is missing THE SYSTEM SHALL fail naming the variable, not its value', async () => {
    const result = await runScript([GUILD], URL_OK, { WEBHOOK_ENC_KEY: '' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('WEBHOOK_ENC_KEY');
  });
});
