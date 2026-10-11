/** Whether a failed outbound call is worth another attempt (DESIGN §8.1). */
export type Outcome = 'retryable' | 'fatal';

/** Port-level description of a failed call; adapters translate fetch/HTTP errors into this (DESIGN §8.1). */
export interface CallFailure {
  /** HTTP status, when there was a response. */
  status?: number;
  /** No response at all. */
  kind?: 'timeout' | 'network';
  /** From Retry-After / Discord's retry_after, already converted to milliseconds by the adapter. */
  retryAfterMs?: number;
}

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;

/**
 * Retryable: timeout, network error, 5xx, 429. Everything else is fatal, including 401/404 from the
 * Discord follow-up, 408 and 425 (DESIGN §8.1, §11.4, §14; CLAUDE.md).
 *
 * Deliberately knows nothing about the call target or token age: what to do after a fatal follow-up
 * (the channel fallback) is the worker's decision (§11.3). A failure with neither a status nor a kind
 * carries no evidence of being transient, so it is fatal rather than retried blindly.
 */
export function classifyFailure(e: CallFailure): Outcome {
  if (e.kind === 'timeout' || e.kind === 'network') {
    return 'retryable';
  }
  if (e.status === HTTP_TOO_MANY_REQUESTS) {
    return 'retryable';
  }
  if (
    e.status !== undefined &&
    e.status >= HTTP_SERVER_ERROR_MIN &&
    e.status <= HTTP_SERVER_ERROR_MAX
  ) {
    return 'retryable';
  }
  return 'fatal';
}

/**
 * Full-jitter exponential backoff (DESIGN §8.1, CLAUDE.md): `rnd() * min(maxMs, baseMs * 2 ** attempt)`.
 *
 * `rnd` is injected (returns a value in [0, 1)) so tests are deterministic. Out-of-range inputs are clamped
 * rather than thrown on: a negative attempt counts as 0 and `rnd` is bounded to [0, 1], so a bad caller can
 * never schedule a negative delay or one above `maxMs`. The result is whole milliseconds.
 */
export function nextBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  rnd: () => number,
): number {
  const exponent = Math.max(0, attempt);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = Math.min(1, Math.max(0, rnd()));
  return Math.floor(jitter * Math.max(0, ceiling));
}

/**
 * Delay before the next attempt (DESIGN §8.1). A server-supplied Retry-After wins and is NOT capped at
 * `maxMs`: retrying earlier earns another 429, and Discord counts repeated 429s toward its invalid-request
 * limit (Cloudflare IP ban). It is rounded up so the next attempt is never earlier than Retry-After.
 * A non-finite Retry-After (adapter parse bug) is ignored in favour of the computed backoff.
 */
export function retryDelayMs(
  e: CallFailure,
  attempt: number,
  baseMs: number,
  maxMs: number,
  rnd: () => number,
): number {
  if (e.retryAfterMs !== undefined && Number.isFinite(e.retryAfterMs)) {
    return Math.max(0, Math.ceil(e.retryAfterMs));
  }
  return nextBackoffMs(attempt, baseMs, maxMs, rnd);
}
