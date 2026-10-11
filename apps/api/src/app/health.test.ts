import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/helpers/authFakes.js';
import type { HealthReader } from '../ports/health.js';
import { HEALTH_CACHE_MS, HealthService, healthHttpStatus } from './health.js';

const STALE_AFTER_MS = 60_000;
const START_MS = 1_800_000_000_000;

class FakeReader implements HealthReader {
  public calls = 0;
  public behaviour: () => Promise<number | null> = () => Promise.resolve(START_MS);

  public lastWorkerBeatMs(): Promise<number | null> {
    this.calls += 1;
    return this.behaviour();
  }
}

function build(timeoutMs = 50) {
  const clock = new ManualClock(START_MS);
  const reader = new FakeReader();
  const service = new HealthService(reader, clock, { timeoutMs, staleAfterMs: STALE_AFTER_MS });
  return { clock, reader, service };
}

describe('HealthService', () => {
  it('WHEN the database answers and the worker beat is recent THE SYSTEM SHALL report ok', async () => {
    const { service } = build();

    const report = await service.check();

    expect(report).toEqual({ status: 'ok', db: 'up', worker: 'ok' });
    expect(healthHttpStatus(report)).toBe(200);
  });

  it('WHEN the database does not answer in time THE SYSTEM SHALL report unhealthy without waiting for it', async () => {
    const { reader, service } = build(30);
    reader.behaviour = () => new Promise<number | null>(() => undefined);

    const startedAt = performance.now();
    const report = await service.check();

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(report).toEqual({ status: 'unhealthy', db: 'down', worker: 'unknown' });
    expect(healthHttpStatus(report)).toBe(503);
  });

  it('WHEN the database query fails THE SYSTEM SHALL report unhealthy and carry no error text', async () => {
    const { reader, service } = build();
    reader.behaviour = () =>
      Promise.reject(new Error('password authentication failed for user "x"'));

    const report = await service.check();

    expect(report).toEqual({ status: 'unhealthy', db: 'down', worker: 'unknown' });
    expect(JSON.stringify(report)).not.toContain('password');
  });

  it('WHEN the worker has not beaten for longer than the lease THE SYSTEM SHALL report degraded with HTTP 503', async () => {
    const { clock, reader, service } = build();
    clock.advance(STALE_AFTER_MS + HEALTH_CACHE_MS);
    reader.behaviour = () => Promise.resolve(START_MS);

    const report = await service.check();

    expect(report).toEqual({ status: 'degraded', db: 'up', worker: 'stale' });
    expect(healthHttpStatus(report)).toBe(503);
  });

  it('WHEN no worker has ever beaten and the process is old THE SYSTEM SHALL report the worker stale', async () => {
    const { clock, reader, service } = build();
    clock.advance(STALE_AFTER_MS + 1);
    reader.behaviour = () => Promise.resolve(null);

    expect((await service.check()).worker).toBe('stale');
  });

  it('WHEN the process just started and the only beat is old THE SYSTEM SHALL report starting, not failed', async () => {
    const { reader, service } = build();
    reader.behaviour = () => Promise.resolve(START_MS - 3_600_000);

    const report = await service.check();

    expect(report).toEqual({ status: 'ok', db: 'up', worker: 'starting' });
  });

  it('WHEN checks arrive faster than the cache window THE SYSTEM SHALL query the database once', async () => {
    const { clock, reader, service } = build();

    await Promise.all([service.check(), service.check(), service.check()]);
    clock.advance(HEALTH_CACHE_MS - 1);
    await service.check();
    expect(reader.calls).toBe(1);

    clock.advance(1);
    await service.check();
    expect(reader.calls).toBe(2);
  });

  it('THE SYSTEM SHALL expose only status words: no counts, ids or timestamps', async () => {
    const { service } = build();

    expect(Object.keys(await service.check()).sort()).toEqual(['db', 'status', 'worker']);
  });
});
