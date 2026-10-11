// Readable reasons for a failed call, written for the admin who reads the dashboard (user-facing-messages
// skill). They end up in job_attempt.error and job.last_error, so they never contain a URL, a token or any part
// of a response body: only the target, the HTTP status and what to do about it.
import type { CallFailure } from './retry.js';

export type FailureTarget = 'mirror' | 'followup' | 'fallback';

const HTTP = {
  REDIRECT_MIN: 300,
  REDIRECT_MAX: 399,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  GONE: 410,
  TOO_MANY_REQUESTS: 429,
  SERVER_ERROR_MIN: 500,
} as const;

/** The stored webhook could not be decrypted (wrong key, tampering). Fixed text: nothing is learned from it. */
export const MIRROR_UNREADABLE =
  'The saved Slack webhook could not be read. Set the webhook URL again on the dashboard.';
/** The job's payload column is not what the code wrote. */
export const PAYLOAD_UNREADABLE =
  'The saved report data could not be read, so it was not processed.';

export function withAttemptLimit(reason: string, attempts: number): string {
  return `${reason} Gave up after ${String(attempts)} attempts.`;
}

const NAMES: Record<FailureTarget, string> = {
  mirror: 'Slack',
  followup: 'Discord',
  fallback: 'Discord',
};

export function describeFailure(target: FailureTarget, failure: CallFailure): string {
  const name = NAMES[target];
  if (failure.kind === 'timeout') {
    return `${name} did not answer in time.`;
  }
  if (failure.kind === 'network') {
    return `Could not reach ${name}.`;
  }
  const { status } = failure;
  if (status === undefined) {
    return target === 'mirror'
      ? 'The saved webhook address is not an allowed Slack webhook, so nothing was sent.'
      : `${name} could not be called.`;
  }
  return describeStatus(target, name, status);
}

function describeStatus(target: FailureTarget, name: string, status: number): string {
  const code = `(HTTP ${String(status)})`;
  if (status >= HTTP.REDIRECT_MIN && status <= HTTP.REDIRECT_MAX) {
    return `${name} answered with a redirect ${code}, which is not followed.`;
  }
  if (status === HTTP.TOO_MANY_REQUESTS) {
    return `${name} is rate limiting us ${code}.`;
  }
  if (status >= HTTP.SERVER_ERROR_MIN) {
    return `${name} had a problem on its side ${code}.`;
  }
  return fatalStatus(target, name, status, code);
}

function fatalStatus(target: FailureTarget, name: string, status: number, code: string): string {
  const gone = status === HTTP.NOT_FOUND || status === HTTP.GONE;
  switch (target) {
    case 'mirror':
      return gone
        ? `Slack says the webhook no longer exists ${code}. Set a new webhook URL on the dashboard.`
        : `Slack rejected the notification ${code}. Check the webhook URL on the dashboard.`;
    case 'followup':
      return status === HTTP.UNAUTHORIZED || gone
        ? `Discord no longer accepts this reply ${code}, so the answer was posted in the channel instead.`
        : `${name} rejected the reply ${code}.`;
    case 'fallback':
      return status === HTTP.FORBIDDEN
        ? `The bot cannot post in that channel ${code}. Give it View Channel and Send Messages.`
        : gone
          ? `Discord could not find that channel ${code}.`
          : `${name} rejected the channel post ${code}.`;
  }
}
