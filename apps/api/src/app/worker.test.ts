import { describe, expect, it, vi } from 'vitest';

import { LogSink } from '../../test/helpers/logging.js';
import { createLogger } from '../http/middleware.js';
import type { ClaimedJob, ClaimRequest, JobRepository } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import {
  failureBackoffMs,
  FAILURE_LOG_EVERY,
  MAX_FAILURE_BACKOFF_MS,
  Worker,
  type JobRunner,
} from './worker.js';

const NOW_MS = 1_800_000_000_000;
const OPTIONS = { batch: 3, pollIntervalMs: 10, leaseMs: 60_000 };

function job(id: string): ClaimedJob {
  return {
    id,
    interactionId: `interaction-${id}`,
    guildId: 'g',
    attempts: 1,
    claimedAt: new Date(NOW_MS),
    interactionToken: 'fake-token',
    tokenExpiresAt: null,
    payload: {},
    mirrorStatus: 'pending',
    mirrorWebhookEnc: null,
    postChannelId: null,
    channelId: 'c',
  };
}

/** Hands out the queued jobs in batches, like a real claim, and remembers what it was asked. */
class FakeJobs implements JobRepository {
  public readonly requests: ClaimRequest[] = [];
  public constructor(private queue: ClaimedJob[]) {}

  public claim(request: ClaimRequest): Promise<ClaimedJob[]> {
    this.requests.push(request);
    const batch = this.queue.slice(0, request.limit);
    this.queue = this.queue.slice(request.limit);
    return Promise.resolve(batch);
  }

  public commitStep(): Promise<'applied'> {
    return Promise.resolve('applied');
  }
}

function setup(
  jobs: ClaimedJob[],
  run: JobRunner['run'],
  beat = (): Promise<void> => Promise.resolve(),
  options = OPTIONS,
) {
  const sink = new LogSink();
  const logger: Logger = createLogger('debug', sink);
  const repo = new FakeJobs(jobs);
  const beats: number[] = [];
  const worker = new Worker(
    {
      jobs: repo,
      runner: { run },
      heartbeat: {
        beat: (nowMs) => {
          beats.push(nowMs);
          return beat();
        },
      },
      clock: { nowMs: () => NOW_MS },
      logger,
    },
    options,
  );
  return { worker, repo, sink, beats };
}

describe('Worker.tick', () => {
  it('SHALL claim up to the batch size with the lease and the current time, and run every claimed job', async () => {
    const ran: string[] = [];
    const { worker, repo } = setup([job('1'), job('2'), job('3'), job('4')], (claimed) => {
      ran.push(claimed.id);
      return Promise.resolve();
    });

    const claimed = await worker.tick();

    expect(claimed).toBe(3);
    expect(ran.sort()).toEqual(['1', '2', '3']);
    expect(repo.requests).toEqual([{ limit: 3, nowMs: NOW_MS, leaseMs: 60_000 }]);
  });

  it('SHALL run the claimed jobs concurrently, not one after another', async () => {
    let running = 0;
    let peak = 0;
    const { worker } = setup([job('1'), job('2'), job('3')], async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    });

    await worker.tick();

    expect(peak).toBe(3);
  });

  it('WHEN one job throws THE SYSTEM SHALL still finish its neighbours and log the failure once without the token', async () => {
    const finished: string[] = [];
    const { worker, sink } = setup([job('1'), job('2'), job('3')], async (claimed) => {
      await Promise.resolve();
      if (claimed.id === '2') {
        throw new Error('connection reset fake-token');
      }
      finished.push(claimed.id);
    });

    await expect(worker.tick()).resolves.toBe(3);

    expect(finished.sort()).toEqual(['1', '3']);
    const failures = sink.records().filter((record) => record.msg === 'worker.job_pass_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ job_id: '2', errorName: 'Error' });
    expect(sink.text()).not.toContain('fake-token');
  });

  it('SHALL write a heartbeat on every tick, even when nothing is claimed', async () => {
    const { worker, beats } = setup([], () => Promise.resolve());

    await worker.tick();
    await worker.tick();

    expect(beats).toEqual([NOW_MS, NOW_MS]);
  });

  it('WHEN the heartbeat write fails THE SYSTEM SHALL still claim and run jobs', async () => {
    const ran: string[] = [];
    const { worker, sink } = setup(
      [job('1')],
      (claimed) => {
        ran.push(claimed.id);
        return Promise.resolve();
      },
      () => Promise.reject(new Error('db down')),
    );

    await worker.tick();

    expect(ran).toEqual(['1']);
    expect(sink.messages()).toContain('worker.heartbeat_failed');
  });

  it('WHEN claiming fails THE SYSTEM SHALL reject, so the loop can log it and wait', async () => {
    const sink = new LogSink();
    const worker = new Worker(
      {
        jobs: {
          claim: () => Promise.reject(new Error('db down')),
          commitStep: () => Promise.resolve('applied'),
        },
        runner: { run: () => Promise.resolve() },
        heartbeat: { beat: () => Promise.resolve() },
        clock: { nowMs: () => NOW_MS },
        logger: createLogger('debug', sink),
      },
      OPTIONS,
    );

    await expect(worker.tick()).rejects.toThrow('db down');
  });
});

describe('Worker loop', () => {
  it('SHALL drain queued work, keep polling, and stop cleanly', async () => {
    const ran: string[] = [];
    const { worker, repo } = setup(
      [job('1'), job('2'), job('3'), job('4'), job('5')],
      (claimed) => {
        ran.push(claimed.id);
        return Promise.resolve();
      },
    );

    worker.start();
    await waitFor(() => ran.length === 5);
    const requestsWhenDrained = repo.requests.length;
    await worker.stop();

    expect(ran.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(requestsWhenDrained).toBeGreaterThanOrEqual(2);
  });

  it('WHEN nudged while idle THE SYSTEM SHALL poll at once instead of waiting out the interval', async () => {
    const sink = new LogSink();
    const repo = new FakeJobs([]);
    const worker = new Worker(
      {
        jobs: repo,
        runner: { run: () => Promise.resolve() },
        heartbeat: { beat: () => Promise.resolve() },
        clock: { nowMs: () => NOW_MS },
        logger: createLogger('debug', sink),
      },
      { ...OPTIONS, pollIntervalMs: 60_000 },
    );

    worker.start();
    await waitFor(() => repo.requests.length === 1);
    worker.nudge();
    await waitFor(() => repo.requests.length === 2);
    await worker.stop();

    expect(repo.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('WHEN stopped THE SYSTEM SHALL wait for the jobs in flight and claim nothing more', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const { worker, repo } = setup([job('1'), job('2'), job('3'), job('4')], async () => {
      await gate;
      finished = true;
    });

    worker.start();
    await waitFor(() => repo.requests.length === 1);
    const stopping = worker.stop();
    release();
    await stopping;

    expect(finished).toBe(true);
    expect(repo.requests).toHaveLength(1);
  });

  it('WHEN claiming keeps failing THE SYSTEM SHALL log it and keep the loop alive', async () => {
    const sink = new LogSink();
    let calls = 0;
    const worker = new Worker(
      {
        jobs: {
          claim: () => {
            calls += 1;
            return Promise.reject(new Error('db down'));
          },
          commitStep: () => Promise.resolve('applied'),
        },
        runner: { run: () => Promise.resolve() },
        heartbeat: { beat: () => Promise.resolve() },
        clock: { nowMs: () => NOW_MS },
        logger: createLogger('debug', sink),
      },
      OPTIONS,
    );

    worker.start();
    await waitFor(() => calls >= 3);
    await worker.stop();

    expect(sink.messages()).toContain('worker.tick_failed');
  });

  describe('while the database is down', () => {
    function downThenUp(sink: LogSink, beatFails = true) {
      const state = { down: true, claims: 0 };
      const worker = new Worker(
        {
          jobs: {
            claim: () => {
              state.claims += 1;
              return state.down ? Promise.reject(new Error('db down')) : Promise.resolve([]);
            },
            commitStep: () => Promise.resolve('applied'),
          },
          runner: { run: () => Promise.resolve() },
          heartbeat: {
            beat: () =>
              beatFails && state.down ? Promise.reject(new Error('db down')) : Promise.resolve(),
          },
          clock: { nowMs: () => NOW_MS },
          logger: createLogger('debug', sink),
        },
        { ...OPTIONS, pollIntervalMs: 100 },
      );
      return { state, worker };
    }

    it('SHALL double the wait after each failed tick up to the cap', () => {
      const waits = [1, 2, 3, 4, 10, 100].map((n) => failureBackoffMs(100, n));

      expect(waits).toEqual([100, 200, 400, 800, MAX_FAILURE_BACKOFF_MS, MAX_FAILURE_BACKOFF_MS]);
      expect(failureBackoffMs(60_000, 3)).toBe(60_000); // never below the poll interval
    });

    it('SHALL poll less and less often instead of every interval', async () => {
      vi.useFakeTimers();
      try {
        const { worker, state } = downThenUp(new LogSink());

        worker.start();
        await vi.advanceTimersByTimeAsync(1_500); // fixed 100 ms polling would be about 15 claims
        const claimsInOutage = state.claims;
        await worker.stop();

        expect(claimsInOutage).toBeGreaterThanOrEqual(4);
        expect(claimsInOutage).toBeLessThanOrEqual(6); // at t = 0, 100, 300, 700, 1500
      } finally {
        vi.useRealTimers();
      }
    });

    it('SHALL log the first failure and then one per FAILURE_LOG_EVERY, and the heartbeat once', async () => {
      vi.useFakeTimers();
      try {
        const sink = new LogSink();
        const { worker, state } = downThenUp(sink);

        worker.start();
        await vi.advanceTimersByTimeAsync(MAX_FAILURE_BACKOFF_MS * FAILURE_LOG_EVERY);
        await worker.stop();

        const tickLogs = sink.records().filter((record) => record.msg === 'worker.tick_failed');
        expect(state.claims).toBeGreaterThan(FAILURE_LOG_EVERY);
        expect(tickLogs[0]).toMatchObject({ consecutiveFailures: 1 });
        expect(tickLogs[1]).toMatchObject({ consecutiveFailures: FAILURE_LOG_EVERY });
        expect(sink.messages().filter((m) => m === 'worker.heartbeat_failed')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('WHEN the database comes back THE SYSTEM SHALL log one recovery and poll at the normal interval again', async () => {
      vi.useFakeTimers();
      try {
        const sink = new LogSink();
        const { worker, state } = downThenUp(sink);

        worker.start();
        await vi.advanceTimersByTimeAsync(700);
        state.down = false;
        await vi.advanceTimersByTimeAsync(800); // the wait that was already running ends, the tick succeeds
        const claimsAtRecovery = state.claims;
        await vi.advanceTimersByTimeAsync(1_000);
        await worker.stop();

        expect(sink.messages().filter((m) => m === 'worker.recovered')).toHaveLength(1);
        expect(sink.messages()).toContain('worker.heartbeat_recovered');
        expect(state.claims - claimsAtRecovery).toBeGreaterThanOrEqual(9); // 100 ms polling again
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('SHALL ignore a second start()', async () => {
    const { worker, repo } = setup([], () => Promise.resolve(), undefined, {
      ...OPTIONS,
      pollIntervalMs: 60_000,
    });

    worker.start();
    worker.start();
    await waitFor(() => repo.requests.length >= 1);
    await worker.stop();

    // With a long poll interval each loop claims exactly once before it idles; a second loop would claim twice.
    expect(repo.requests).toHaveLength(1);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
