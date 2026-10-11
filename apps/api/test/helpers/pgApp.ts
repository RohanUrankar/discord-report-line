import type pg from 'pg';
import request, { type Test } from 'supertest';

import { PgLedger } from '../../src/adapters/pg/pgLedger.js';
import { PgStatusReader } from '../../src/adapters/pg/pgStatusReader.js';
import { InteractionController } from '../../src/app/interactions.js';
import { createLogger } from '../../src/http/middleware.js';
import { createServer } from '../../src/http/server.js';
import type { LedgerService } from '../../src/ports/ledger.js';
import { inertAuth } from './authFakes.js';
import { LogSink } from './logging.js';
import { generateTestKeypair, signRequest, unixSeconds } from './signing.js';

/** Fixed "now" for signed requests, so the replay window never depends on the wall clock. */
export const NOW_MS = Date.UTC(2026, 9, 11, 15, 30);

export interface Reply {
  type: number;
  data: { content: string; flags?: number };
}

/** The production wiring of src/index.ts (real ledger, real status reader) around the given pool. */
export interface WireOptions {
  /** Makes the ledger slower than the record timeout, to exercise the late-commit case. */
  recordDelayMs?: number;
  recordTimeoutMs?: number;
}

export function wire(
  pool: pg.Pool,
  options: WireOptions = {},
): { send: (payload: unknown) => Test; sink: LogSink } {
  const keypair = generateTestKeypair();
  const sink = new LogSink();
  const clock = { nowMs: (): number => NOW_MS };
  const controller = new InteractionController({
    publicKeyHex: keypair.publicKeyHex,
    replayWindowMs: 300_000,
    statusTimeoutMs: 1500,
    recordTimeoutMs: options.recordTimeoutMs ?? 1200,
    clock,
    ledger: delayed(new PgLedger(pool), options.recordDelayMs),
    statusReader: new PgStatusReader(pool, clock),
  });
  const app = createServer({ controller, logger: createLogger('debug', sink), ...inertAuth() });
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

/** The real ledger, optionally made slow: the write still commits, just after the controller gave up. */
function delayed(ledger: LedgerService, delayMs: number | undefined): LedgerService {
  if (delayMs === undefined) {
    return ledger;
  }
  return {
    recordAndEnqueue: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return ledger.recordAndEnqueue(input);
    },
  };
}

/**
 * The HTTP path stamps `job.next_run_at` from the database clock, while workers in these tests run on the
 * fixed `NOW_MS` clock. Once the wall clock passes `NOW_MS` the job looks "not due yet" to the worker, so
 * pin every job to the test clock.
 */
export async function makeJobsDue(pool: pg.Pool): Promise<void> {
  await pool.query('UPDATE job SET next_run_at = $1', [new Date(NOW_MS)]);
}
