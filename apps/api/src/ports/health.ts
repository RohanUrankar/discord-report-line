/**
 * What `/healthz` reads. One cheap query that proves the database answers and returns the worker's last
 * heartbeat (null: no worker has ever beaten). Rejects when the database is unreachable.
 */
export interface HealthReader {
  lastWorkerBeatMs(): Promise<number | null>;
}
