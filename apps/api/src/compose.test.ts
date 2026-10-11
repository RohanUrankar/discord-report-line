import { describe, expect, it } from 'vitest';

import { silentLogger, testDatabaseUrl, truncateAll, useTestDatabase } from '../test/helpers/db.js';
import { loadWorkerConfig } from './config.js';
import { composeWorker } from './compose.js';

const db = useTestDatabase();

describe('composeWorker', () => {
  it('WHEN started THE SYSTEM SHALL beat on its own pool, and WHEN stopped SHALL release it', async () => {
    await truncateAll(db());
    const config = loadWorkerConfig({
      DATABASE_URL: testDatabaseUrl(),
      DISCORD_APP_ID: '900000000000000005',
      DISCORD_BOT_TOKEN: 'fake-bot-token-do-not-log',
      WEBHOOK_ENC_KEY: Buffer.alloc(32, 8).toString('base64'),
      POLL_INTERVAL_MS: '20',
    });
    const { worker, pool } = composeWorker(config, silentLogger);

    worker.start();
    await waitUntil(
      async () => (await db().query('SELECT 1 FROM worker_heartbeat')).rows.length === 1,
    );
    await worker.stop();
    await pool.end();

    expect(pool.ended).toBe(true);
  });
});

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
