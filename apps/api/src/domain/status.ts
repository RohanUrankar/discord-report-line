export interface StatusCounts {
  reportsToday: number;
  retrying: number;
  /** Seconds since the worker's last heartbeat; null when it has never reported. */
  workerLastBeatSeconds: number | null;
}

/** `/status` text (§5.1). */
export function statusText(counts: StatusCounts): string {
  const worker =
    counts.workerLastBeatSeconds === null
      ? "The worker hasn't checked in yet"
      : `Worker last active ${String(Math.max(0, Math.round(counts.workerLastBeatSeconds)))} s ago`;
  return `Reports today: ${String(counts.reportsToday)} · Retrying: ${String(counts.retrying)} · ${worker}.`;
}
