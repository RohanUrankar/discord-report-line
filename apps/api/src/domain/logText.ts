// Free text that reaches the dashboard from the job tables (job.last_error, job_attempt.error). The worker
// already writes fixed sentences with no URL in them (failureReasons.ts); this is the second lock on that
// door: whatever a future code path stores, no link (a Slack webhook is a secret) and no wall of text
// leaves the API.

const REMOVED = '[link removed]';
export const MAX_LOG_TEXT_LENGTH = 300;

// A scheme://... URL, a bare Slack webhook host, or a webhook-style /services/... path.
const LINKS = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bhooks\.slack\.com\S*|\/services\/\S+/gi;

export function readableLogText(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const cleaned = text.replace(LINKS, REMOVED);
  return cleaned.length > MAX_LOG_TEXT_LENGTH
    ? `${cleaned.slice(0, MAX_LOG_TEXT_LENGTH - 1)}…`
    : cleaned;
}
