// Stores a server's Slack Incoming Webhook URL, encrypted (AES-256-GCM). Run by hand:
//   npm run set-mirror-webhook -- <discord-server-id>
// then paste the URL and press Enter (or pipe it in). The URL is read from standard input only, so it never
// appears in a command line, shell history or process list, and it is never printed.
import { stdin } from 'node:process';

import pg from 'pg';

import { AesGcmWebhookCipher } from '../apps/api/src/adapters/aesGcmWebhookCipher.js';
import { PgMirrorWebhookStore } from '../apps/api/src/adapters/pg/pgMirrorWebhookStore.js';
import { saveMirrorWebhook } from '../apps/api/src/app/mirrorWebhook.js';
import { ConfigError, loadWebhookScriptConfig } from '../apps/api/src/config.js';
import { errorLogFields } from '../apps/api/src/domain/errorFields.js';

const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const MAX_STDIN_BYTES = 4096; // a webhook URL is ~80 characters; refuse anything absurd
const SNOWFLAKE = /^\d{17,20}$/;

class UsageError extends Error {}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) {
      throw new UsageError('That input is too long to be a webhook URL.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const guildId = process.argv[2];
  if (guildId === undefined || !SNOWFLAKE.test(guildId)) {
    throw new UsageError(
      'Usage: npm run set-mirror-webhook -- <discord-server-id>, then paste the URL.',
    );
  }
  const config = loadWebhookScriptConfig();
  const url = await readStdin();

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  try {
    const result = await saveMirrorWebhook(
      { guildId, url, allowedPrefix: config.SLACK_WEBHOOK_URL_PREFIX },
      {
        cipher: new AesGcmWebhookCipher(config.WEBHOOK_ENC_KEY),
        store: new PgMirrorWebhookStore(pool),
      },
    );
    if (!result.ok) {
      throw new UsageError(
        'That is not a Slack webhook URL. It must start with https://hooks.slack.com/services/.',
      );
    }
    process.stdout.write(
      `Saved the notification webhook for server ${guildId} (ends in ${result.endsIn}).\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${describeFailure(error)}\n`);
  process.exit(1);
});

/** Only messages we wrote ourselves are printed. Anything else is reduced to its error code. */
function describeFailure(error: unknown): string {
  if (error instanceof UsageError || error instanceof ConfigError) {
    return error.message;
  }
  const { errorName, errorCode } = errorLogFields(error);
  return `Could not save the webhook (${errorCode ?? errorName}). Check DATABASE_URL.`;
}
