import type {
  AttemptView,
  GuildSummary,
  InteractionDetail,
  InteractionLogItem,
} from '@report-line/shared';

import { readableLogText } from '../domain/logText.js';
import type { AttemptRecord, GuildRecord, LogRecord } from '../ports/dashboard.js';

// The ONE place a stored row becomes an API response. Every field is named here; nothing is spread or passed
// through, so a column added to a table never reaches the dashboard unless it is added below on purpose.

export function toGuildSummary(row: GuildRecord): GuildSummary {
  return { id: row.id, name: row.name };
}

export function toLogItem(row: LogRecord): InteractionLogItem {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    command: row.command,
    userId: row.userId,
    interactionStatus: row.interactionStatus,
    action:
      row.action === null
        ? null
        : {
            type: row.action.type,
            mirrorStatus: row.action.mirrorStatus,
            llmTag: row.action.llmTag,
          },
    job:
      row.job === null
        ? null
        : {
            status: row.job.status,
            attempts: row.job.attempts,
            lastError: readableLogText(row.job.lastError),
          },
  };
}

export function toAttemptView(row: AttemptRecord): AttemptView {
  return {
    attemptNo: row.attemptNo,
    target: row.target,
    outcome: row.outcome,
    httpStatus: row.httpStatus,
    error: readableLogText(row.error),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}

export function toDetail(row: LogRecord, attempts: AttemptRecord[]): InteractionDetail {
  return { ...toLogItem(row), attemptHistory: attempts.map(toAttemptView) };
}
