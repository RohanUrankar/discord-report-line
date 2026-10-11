import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../domain/messages.js';
import { deadDatabasePool } from '../../test/helpers/db.js';
import { commandPayload } from '../../test/helpers/payloads.js';
import { wire, type Reply } from '../../test/helpers/pgApp.js';

// Needs no database at all: the pool points at a port nothing listens on.
const EPHEMERAL = 64;

describe('POST /interactions when Postgres is down', () => {
  it('WHEN the database cannot be reached THE SYSTEM SHALL answer an ephemeral "not recorded" within 3 s, never a 500', async () => {
    const pool = deadDatabasePool();
    const { send, sink } = wire(pool);
    const startedAt = performance.now();
    try {
      const res = await send(commandPayload('status'));

      expect(performance.now() - startedAt).toBeLessThan(3000);
      expect(res.status).toBe(200);
      expect((res.body as Reply).data.content).toBe(MESSAGES.notRecorded);
      expect((res.body as Reply).data.flags).toBe(EPHEMERAL);
      expect(sink.messages()).toContain('rule.read_failed');
      expect(sink.text()).not.toContain('postgresql://'); // the connection URL never reaches a log
    } finally {
      await pool.end();
    }
  });
});
