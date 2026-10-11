import type { CallFailure } from '../domain/retry.js';

/**
 * The result of one outbound call, in port-level terms (resilience skill). Adapters never throw for a failed
 * call and never leak a raw fetch error: they return what `classifyFailure` needs and nothing else, so no URL,
 * token or response body can travel upward with it.
 */
export type CallResult = { ok: true; status: number } | { ok: false; failure: CallFailure };
