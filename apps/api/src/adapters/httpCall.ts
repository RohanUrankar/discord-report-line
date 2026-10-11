import type { ReadableStreamReadResult } from 'node:stream/web';

import type { CallFailure } from '../domain/retry.js';
import type { CallResult } from '../ports/outbound.js';

const MAX_ERROR_BODY_BYTES = 4096; // a rate-limit body is tiny; never buffer an unbounded one (resilience skill)
const MS_PER_SECOND = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

export interface HttpRequest {
  url: string;
  method: 'POST' | 'PATCH';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}

/**
 * The one place that turns `fetch` into a `CallResult` (DESIGN §8.1). Every call has an AbortSignal timeout and
 * `redirect: 'manual'`, so an allowed host cannot bounce the worker to an internal one: a 3xx comes back as a
 * status and is fatal. The result carries a status or a kind and never the URL, the token or the body.
 */
export async function performCall(request: HttpRequest): Promise<CallResult> {
  let response: Response;
  try {
    response = await request.fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    return { ok: false, failure: { kind: isTimeout(error) ? 'timeout' : 'network' } };
  }
  if (response.status >= HTTP_OK_MIN && response.status <= HTTP_OK_MAX) {
    await discardBody(response);
    return { ok: true, status: response.status };
  }
  const failure: CallFailure = { status: response.status };
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    const retryAfterMs = await readRetryAfterMs(response);
    if (retryAfterMs !== undefined) {
      failure.retryAfterMs = retryAfterMs;
    }
  } else {
    await discardBody(response);
  }
  return { ok: false, failure };
}

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is being dropped anyway.
  }
}

/**
 * How long the server told us to wait, from the `Retry-After` header and Discord's `retry_after` JSON field
 * (both seconds, either may be fractional). If both are present the later one wins: retrying earlier than
 * either earns another 429. Rounded up to a whole millisecond; never capped (retry.ts).
 */
async function readRetryAfterMs(response: Response): Promise<number | undefined> {
  const header = response.headers.get('retry-after');
  const fromHeader = header === null ? undefined : toMs(Number(header));
  const fromBody = toMs(await readRetryAfterSeconds(response));
  const found = [fromHeader, fromBody].filter((ms): ms is number => ms !== undefined);
  return found.length === 0 ? undefined : Math.max(...found);
}

function toMs(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.ceil(seconds * MS_PER_SECOND);
}

async function readRetryAfterSeconds(response: Response): Promise<number | undefined> {
  try {
    const json: unknown = JSON.parse(await readBounded(response));
    if (typeof json === 'object' && json !== null && 'retry_after' in json) {
      return typeof json.retry_after === 'number' ? json.retry_after : undefined;
    }
  } catch {
    // Not JSON, too large, or the read timed out: the header alone (or normal backoff) will do.
  }
  return undefined;
}

async function readBounded(response: Response): Promise<string> {
  return (await readBoundedBody(response, MAX_ERROR_BODY_BYTES)).text;
}

/**
 * Reads at most `maxBytes` of a body, then drops the connection. `truncated` says the body was longer, so a
 * caller that needs the whole thing (a JSON answer) can refuse a partial one. A read that fails (timeout)
 * throws, as `fetch` does.
 */
export async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { text: '', truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  try {
    while (total <= maxBytes) {
      const result: ReadableStreamReadResult<unknown> = await reader.read();
      if (result.done) {
        finished = true;
        break;
      }
      if (result.value instanceof Uint8Array) {
        chunks.push(result.value);
        total += result.value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
    truncated: !finished || total > maxBytes,
  };
}
