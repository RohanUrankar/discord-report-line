import type pg from 'pg';
import request, { type Test } from 'supertest';

import { PgLedger } from '../../src/adapters/pg/pgLedger.js';
import { PgStatusReader } from '../../src/adapters/pg/pgStatusReader.js';
import { InteractionController } from '../../src/app/interactions.js';
import { createLogger } from '../../src/http/middleware.js';
import { createServer } from '../../src/http/server.js';
import { LogSink } from './logging.js';
import { generateTestKeypair, signRequest, unixSeconds } from './signing.js';

/** Fixed "now" for signed requests, so the replay window never depends on the wall clock. */
export const NOW_MS = Date.UTC(2026, 9, 11, 15, 30);

export interface Reply {
  type: number;
  data: { content: string; flags?: number };
}

/** The production wiring of src/index.ts (real ledger, real status reader) around the given pool. */
export function wire(pool: pg.Pool): { send: (payload: unknown) => Test; sink: LogSink } {
  const keypair = generateTestKeypair();
  const sink = new LogSink();
  const clock = { nowMs: (): number => NOW_MS };
  const controller = new InteractionController({
    publicKeyHex: keypair.publicKeyHex,
    replayWindowMs: 300_000,
    statusTimeoutMs: 1500,
    recordTimeoutMs: 1200,
    clock,
    ledger: new PgLedger(pool),
    statusReader: new PgStatusReader(pool, clock),
  });
  const app = createServer({ controller, logger: createLogger('debug', sink) });
  const send = (payload: unknown) => {
    const body = JSON.stringify(payload);
    return request(app)
      .post('/interactions')
      .set('Content-Type', 'application/json')
      .set({ ...signRequest(keypair, unixSeconds(NOW_MS), body) })
      .send(body);
  };
  return { send, sink };
}
