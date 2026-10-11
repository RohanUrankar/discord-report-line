/** Injected so replay-window and timeout tests are deterministic (DESIGN §7). */
export interface Clock {
  nowMs(): number;
}
