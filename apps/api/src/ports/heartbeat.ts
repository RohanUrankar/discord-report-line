/** The worker's proof of life, read back by `/status` as "Worker last active N s ago". */
export interface WorkerHeartbeat {
  beat(nowMs: number): Promise<void>;
}
