import type { Clock } from '../ports/clock.js';
import type { HealthReader } from '../ports/health.js';
import { withDeadline } from './deadline.js';

/** A busy pinger or a scanner must not turn `/healthz` into database load: answers are reused this long. */
export const HEALTH_CACHE_MS = 5000;

export interface HealthReport {
  /** `ok` only when the database answers and the worker is alive (or still starting). */
  status: 'ok' | 'degraded' | 'unhealthy';
  db: 'up' | 'down';
  /** `starting`: no fresh beat yet, but the process is younger than the stale limit. */
  worker: 'ok' | 'starting' | 'stale' | 'unknown';
}

export interface HealthOptions {
  /** How long a database answer may take. A cold hosted database wakes within this; a dead one is reported down. */
  timeoutMs: number;
  /** A beat older than this means the worker loop is dead. The lease length: the same "presumed dead" rule. */
  staleAfterMs: number;
}

/**
 * The `/healthz` verdict (DESIGN §14 Observability). Unauthenticated, so the report is three words and no
 * counts, ids or error text: nothing about any server leaves through it. It is also what a keep-warm pinger
 * hits (Appendix A), so one successful call wakes a suspended hosted database as a side effect.
 */
export class HealthService {
  private readonly startedAtMs: number;
  private cached: { atMs: number; report: HealthReport } | undefined;
  private inFlight: Promise<HealthReport> | undefined;

  public constructor(
    private readonly reader: HealthReader,
    private readonly clock: Clock,
    private readonly options: HealthOptions,
  ) {
    this.startedAtMs = clock.nowMs();
  }

  public check(): Promise<HealthReport> {
    const now = this.clock.nowMs();
    if (this.cached !== undefined && now - this.cached.atMs < HEALTH_CACHE_MS) {
      return Promise.resolve(this.cached.report);
    }
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async probe(): Promise<HealthReport> {
    const report = await this.measure();
    this.cached = { atMs: this.clock.nowMs(), report };
    return report;
  }

  private async measure(): Promise<HealthReport> {
    let lastBeatMs: number | null;
    try {
      lastBeatMs = await withDeadline(this.reader.lastWorkerBeatMs(), this.options.timeoutMs);
    } catch {
      return { status: 'unhealthy', db: 'down', worker: 'unknown' };
    }
    const worker = this.workerState(lastBeatMs);
    const alive = worker === 'ok' || worker === 'starting';
    return { status: alive ? 'ok' : 'degraded', db: 'up', worker };
  }

  private workerState(lastBeatMs: number | null): HealthReport['worker'] {
    const now = this.clock.nowMs();
    if (lastBeatMs !== null && now - lastBeatMs <= this.options.staleAfterMs) {
      return 'ok';
    }
    // The first beat lands right after boot; until the process is older than the limit, a missing or old
    // beat (left by the previous run) is not yet a failure.
    return now - this.startedAtMs <= this.options.staleAfterMs ? 'starting' : 'stale';
  }
}

/** HTTP status for a report: anything but `ok` is 503, so a host health check restarts a dead instance. */
export function healthHttpStatus(report: HealthReport): 200 | 503 {
  return report.status === 'ok' ? 200 : 503;
}
