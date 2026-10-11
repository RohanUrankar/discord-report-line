import { errorLogFields } from '../domain/errorFields.js';
import type { Clock } from '../ports/clock.js';
import type { WorkerHeartbeat } from '../ports/heartbeat.js';
import type { ClaimedJob, JobRepository } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';

/** What the worker needs from whatever knows how to process a claimed job (a report, later a button). */
export interface JobRunner {
  run(job: ClaimedJob, log: Logger): Promise<void>;
}

export interface WorkerOptions {
  /** Jobs claimed per tick, and so the most that run concurrently (DESIGN §7.1). */
  batch: number;
  /** Idle wait between polls when nothing was claimed. */
  pollIntervalMs: number;
  /** After this long a `processing` job is presumed orphaned and claimable again. */
  leaseMs: number;
}

export interface WorkerDeps {
  jobs: JobRepository;
  runner: JobRunner;
  heartbeat: WorkerHeartbeat;
  clock: Clock;
  logger: Logger;
}

/**
 * The outbox drainer (DESIGN §7.1, ADR-0002): claim due jobs, run them concurrently, repeat. An async loop on the
 * one event loop, not a thread: every job is I/O-bound. It is a plain class with a `tick()` so a test can drive it
 * step by step, and so the same code runs in-process or standalone.
 */
export class Worker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private nudged = false;

  public constructor(
    private readonly deps: WorkerDeps,
    private readonly options: WorkerOptions,
  ) {}

  /** Starts the poll loop. Calling it twice does nothing. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.runLoop();
  }

  /** Stops claiming and waits for the jobs in flight. Whatever a crash would leave, the lease recovers. */
  public async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  /** "A job was just committed": skip the rest of the idle wait. Safe to call from the request path. */
  public nudge(): void {
    if (this.wake === undefined) {
      this.nudged = true; // mid-tick: the next idle wait returns at once
      return;
    }
    this.wake();
  }

  /**
   * One pass: heartbeat, claim a batch, run it. `Promise.allSettled`, so one job that throws (a database
   * error mid-commit) never cancels its neighbours. Returns how many jobs were claimed.
   */
  public async tick(): Promise<number> {
    const { clock, logger } = this.deps;
    await this.beat();
    const jobs = await this.deps.jobs.claim({
      limit: this.options.batch,
      nowMs: clock.nowMs(),
      leaseMs: this.options.leaseMs,
    });
    const results = await Promise.allSettled(
      jobs.map((job) =>
        this.deps.runner.run(
          job,
          logger.child({ interaction_id: job.interactionId, job_id: job.id }),
        ),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        // The job stays 'processing' and comes back when its lease expires.
        logger.error(
          { ...errorLogFields(result.reason), job_id: jobs[index]?.id },
          'worker.job_pass_failed',
        );
      }
    });
    return jobs.length;
  }

  private async beat(): Promise<void> {
    try {
      await this.deps.heartbeat.beat(this.deps.clock.nowMs());
    } catch (error) {
      // A missed beat must not stop the work; /status just shows an older value.
      this.deps.logger.warn(errorLogFields(error), 'worker.heartbeat_failed');
    }
  }

  /** A method, so the compiler does not assume `running` stays true across an `await` (stop() flips it). */
  private isStopping(): boolean {
    return !this.running;
  }

  private async runLoop(): Promise<void> {
    while (!this.isStopping()) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (error) {
        this.deps.logger.error(errorLogFields(error), 'worker.tick_failed');
      }
      // Work found: look again at once. Nothing found (or the database is failing): wait for the poll or a nudge.
      if (!this.isStopping() && claimed === 0) {
        await this.idle();
      }
    }
  }

  private idle(): Promise<void> {
    if (this.nudged) {
      this.nudged = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.options.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
