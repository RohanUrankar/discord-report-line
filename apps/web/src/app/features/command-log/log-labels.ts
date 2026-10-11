import type {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  AttemptView,
  InteractionLogItem,
  MirrorStatus,
} from '@report-line/shared';

import type { IconName } from '../../shared/ui/icons';
import type { Tone } from '../../shared/ui/status-badge';

// Pure functions that turn the API's closed value sets into words, an icon and a tone. They are the only
// place the dashboard decides how a status reads; the backend decides what the status is (DESIGN §11).

export interface Presentation {
  readonly label: string;
  readonly icon: IconName;
  readonly tone: Tone;
}

export interface RowStatus extends Presentation {
  /** The command did not fully do its job and an admin should look (also what "Needs attention" filters on). */
  readonly needsAttention: boolean;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The main status of a log row. Order matters: the most serious true statement wins. */
export function describeRow(item: InteractionLogItem): RowStatus {
  const { job, interactionStatus } = item;
  if (job?.status === 'dead' && interactionStatus === 'followed_up') {
    return {
      label: 'Reply sent, notification failed',
      icon: 'warning',
      tone: 'warn',
      needsAttention: true,
    };
  }
  if (job?.status === 'dead' || interactionStatus === 'failed') {
    return { label: 'Failed', icon: 'error', tone: 'error', needsAttention: true };
  }
  if (
    job !== null &&
    (job.status === 'pending' || job.status === 'processing') &&
    job.attempts > 0
  ) {
    return {
      label: `Retrying (${plural(job.attempts, 'attempt', 'attempts')} so far)`,
      icon: 'sync',
      tone: 'busy',
      needsAttention: false,
    };
  }
  switch (interactionStatus) {
    case 'deferred':
      return { label: 'Working on it', icon: 'schedule', tone: 'busy', needsAttention: false };
    case 'fallback_posted':
      return {
        label: 'Posted in the channel instead',
        icon: 'chat',
        tone: 'warn',
        needsAttention: false,
      };
    case 'followed_up':
      return { label: 'Replied', icon: 'check_circle', tone: 'ok', needsAttention: false };
    case 'answered':
      return { label: 'Answered', icon: 'check_circle', tone: 'ok', needsAttention: false };
  }
}

const MIRROR: Record<MirrorStatus, Presentation> = {
  pending: { label: 'Sending', icon: 'schedule', tone: 'busy' },
  sent: { label: 'Sent', icon: 'check_circle', tone: 'ok' },
  failed: { label: 'Failed', icon: 'error', tone: 'error' },
  skipped: { label: 'Not needed', icon: 'notifications_off', tone: 'neutral' },
};

/** The Slack notification column. Null when the command has no action (nothing to notify about). */
export function describeNotification(item: InteractionLogItem): Presentation | null {
  if (item.action === null) {
    return null;
  }
  if (item.action.mirrorStatus === 'pending' && item.job?.status === 'dead') {
    return { label: 'Not sent', icon: 'error', tone: 'error' };
  }
  return MIRROR[item.action.mirrorStatus];
}

const CLICK_LABEL: Partial<Record<ActionType, string>> = {
  acknowledged: 'Button: Acknowledge',
  escalated: 'Button: Escalate',
};

/**
 * What to call the thing the user did. A button click has no command name, so it is named by what it did.
 * A form submit is recorded under its command (`/report`), like the text version.
 */
export function commandLabel(item: Pick<InteractionLogItem, 'command' | 'action'>): string {
  if (item.command !== null) {
    return `/${item.command}`;
  }
  return (item.action && CLICK_LABEL[item.action.type]) ?? 'Button click';
}

const TARGET_LABEL: Record<AttemptTarget, string> = {
  tag: 'AI tagging',
  mirror: 'Slack notification',
  followup: 'Reply in Discord',
  fallback: 'Channel post',
};

const TARGET_SERVICE: Record<AttemptTarget, string> = {
  tag: 'The AI service',
  mirror: 'Slack',
  followup: 'Discord',
  fallback: 'Discord',
};

const OUTCOME: Record<AttemptOutcome, Presentation> = {
  success: { label: 'Succeeded', icon: 'check_circle', tone: 'ok' },
  retryable: { label: 'Failed, will retry', icon: 'sync', tone: 'warn' },
  fatal: { label: 'Failed, gave up', icon: 'error', tone: 'error' },
};

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

/** Plain-language reason for a failed attempt, from the target and the HTTP status alone (no raw text). */
export function attemptReason(
  attempt: Pick<AttemptView, 'target' | 'outcome' | 'httpStatus'>,
): string {
  const { target, outcome, httpStatus } = attempt;
  if (outcome === 'success') {
    return 'Done.';
  }
  const service = TARGET_SERVICE[target];
  if (httpStatus === null) {
    return `${service} did not answer in time, or the connection failed.`;
  }
  if (httpStatus === HTTP_TOO_MANY) {
    return `${service} asked us to slow down (rate limited).`;
  }
  if (httpStatus >= HTTP_SERVER_ERROR) {
    return `${service} had a problem on its side (HTTP ${String(httpStatus)}).`;
  }
  if (
    target === 'followup' &&
    (httpStatus === HTTP_UNAUTHORIZED || httpStatus === HTTP_NOT_FOUND)
  ) {
    return 'Discord no longer accepts a reply to this command (its 15-minute window has passed).';
  }
  if (target === 'fallback' && (httpStatus === HTTP_FORBIDDEN || httpStatus === HTTP_NOT_FOUND)) {
    return "The bot can't post in the channel (it lacks permission, or the channel was deleted).";
  }
  if (target === 'mirror' && (httpStatus === HTTP_NOT_FOUND || httpStatus === HTTP_FORBIDDEN)) {
    return `Slack rejected the webhook address (HTTP ${String(httpStatus)}). Check it in Settings.`;
  }
  if (httpStatus >= HTTP_BAD_REQUEST) {
    return `${service} rejected the request (HTTP ${String(httpStatus)}).`;
  }
  return `${service} answered unexpectedly (HTTP ${String(httpStatus)}).`;
}

export interface AttemptPresentation {
  readonly targetLabel: string;
  readonly outcome: Presentation;
  readonly reason: string;
}

export function describeAttempt(attempt: AttemptView): AttemptPresentation {
  return {
    targetLabel: TARGET_LABEL[attempt.target],
    outcome: OUTCOME[attempt.outcome],
    reason: attemptReason(attempt),
  };
}

/** The explicit state the brief asks for: the user got their reply, but the notification never went out. */
export function isReplyDeliveredNotificationFailed(item: InteractionLogItem): boolean {
  return item.job?.status === 'dead' && item.interactionStatus === 'followed_up';
}

export function deadNotificationSummary(item: InteractionLogItem): string {
  const attempts = item.job?.attempts ?? 0;
  return `The user got their reply, but the Slack notification failed after ${plural(attempts, 'attempt', 'attempts')}.`;
}
