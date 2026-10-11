import type { ErrorCode } from '@report-line/shared';

/** Failures that never reach the server's error body: no connection, or a reply we cannot read. */
export type ClientErrorCode = 'NETWORK' | 'BAD_RESPONSE';
export type AppErrorCode = ErrorCode | ClientErrorCode;

export interface AppErrorInit {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly status: number;
  readonly requestId?: string | null;
  readonly fields?: readonly string[];
  readonly retryAfterSeconds?: number | null;
}

/**
 * What every failed call looks like to a component (frontend-guidelines: components never see an
 * HttpErrorResponse). `message` is user-facing text; nothing technical is in it.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  /** Shown as a small "Reference" line so support can find the log line. */
  readonly requestId: string | null;
  /** Field paths the server wants fixed (`mirrorWebhookUrl`, `config.replyMessage`, `(root)`). */
  readonly fields: readonly string[];
  readonly retryAfterSeconds: number | null;

  constructor(init: AppErrorInit) {
    super(init.message);
    this.name = 'AppError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.fields = init.fields ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function isUnauthenticated(value: unknown): boolean {
  return isAppError(value) && value.code === 'UNAUTHENTICATED';
}

/** Anything thrown that is not already an AppError becomes the generic one, so callers handle one shape. */
export function asAppError(value: unknown, message: string): AppError {
  return isAppError(value) ? value : new AppError({ code: 'INTERNAL', message, status: 0 });
}
