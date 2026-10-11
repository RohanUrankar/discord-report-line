import { ErrorCode, errorMessages } from '@report-line/shared';

import type { AppErrorCode, ClientErrorCode } from './app-error';

// Client-only failures. The shared map has no entry for them because the server never sends them.
const clientMessages = {
  NETWORK: "We can't reach the server. Check your connection and try again.",
  BAD_RESPONSE: errorMessages.INTERNAL,
} as const satisfies Record<ClientErrorCode, string>;

/** The one place a code becomes user-facing text. Unknown codes fall back to the generic message. */
export function messageForCode(code: AppErrorCode): string {
  if (code in clientMessages) {
    return clientMessages[code as ClientErrorCode];
  }
  return code in errorMessages ? errorMessages[code as ErrorCode] : errorMessages.INTERNAL;
}

const SECONDS_PER_MINUTE = 60;

/** "42 seconds", "1 minute", "2 minutes 5 seconds": the exact wait the server asked for. */
export function formatWait(totalSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(totalSeconds));
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = seconds % SECONDS_PER_MINUTE;
  const plural = (n: number, unit: string): string => `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes === 0) {
    return plural(rest, 'second');
  }
  return rest === 0
    ? plural(minutes, 'minute')
    : `${plural(minutes, 'minute')} ${plural(rest, 'second')}`;
}

/** Text for a rate-limited call, with the exact wait when the server gave one. */
export function rateLimitedMessage(retryAfterSeconds: number | null): string {
  return retryAfterSeconds === null
    ? messageForCode(ErrorCode.RATE_LIMITED)
    : `Too many attempts. Try again in ${formatWait(retryAfterSeconds)}.`;
}
