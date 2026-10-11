import type { HttpErrorResponse } from '@angular/common/http';
import { ApiErrorBody, ErrorCode } from '@report-line/shared';

import { AppError, type AppErrorCode } from '../errors/app-error';
import { messageForCode } from '../errors/error-messages';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;
const MS_PER_SECOND = 1000;

/** `Retry-After` is whole seconds or an HTTP date; anything else is ignored rather than guessed. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Date.parse accepts far too much ('-5' is a date), so only text that looks like an HTTP date is tried.
  const at = /[A-Za-z]{3}/.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / MS_PER_SECOND));
}

function codeFromStatus(status: number): AppErrorCode {
  if (status === 0) {
    return 'NETWORK';
  }
  if (status === HTTP_UNAUTHORIZED) {
    return ErrorCode.UNAUTHENTICATED;
  }
  if (status === HTTP_NOT_FOUND) {
    return ErrorCode.NOT_FOUND;
  }
  if (status === HTTP_TOO_MANY) {
    return ErrorCode.RATE_LIMITED;
  }
  return ErrorCode.INTERNAL;
}

/**
 * One HttpErrorResponse in, one AppError out. The server's `code` decides the wording (via the shared map);
 * a reply that is not our error body (a proxy's HTML 502, say) is classified by status alone.
 */
export function toAppError(response: HttpErrorResponse): AppError {
  const parsed = ApiErrorBody.safeParse(response.error);
  const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
  if (parsed.success) {
    const { code, requestId, details } = parsed.data.error;
    return new AppError({
      code,
      message: messageForCode(code),
      status: response.status,
      requestId,
      fields: details?.fields ?? [],
      retryAfterSeconds,
    });
  }
  const code = codeFromStatus(response.status);
  return new AppError({
    code,
    message: messageForCode(code),
    status: response.status,
    retryAfterSeconds,
  });
}
