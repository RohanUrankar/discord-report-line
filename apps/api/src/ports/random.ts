/** A number in [0, 1). Injected so backoff jitter is deterministic in tests (DESIGN §7). */
export type Random = () => number;
