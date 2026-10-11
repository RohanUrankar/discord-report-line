import { z } from 'zod';

/** Stable, machine-readable API error codes. The dashboard switches on these (resilience skill). */
export const ErrorCode = {
  INTERNAL: 'INTERNAL',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** No session, or one that expired or was ended. The dashboard sends the admin to the sign-in page. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Wrong email or wrong password: deliberately one code, so a response never says which was wrong. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  CSRF_REJECTED: 'CSRF_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default user-facing text per code (user-facing-messages skill): what happened and what to do. */
export const errorMessages = {
  INTERNAL: 'Something went wrong on our side. Please try again.',
  NOT_FOUND: "We couldn't find that.",
  VALIDATION_FAILED: 'Some fields need attention. Check them and try again.',
  UNAUTHENTICATED: 'Your session ended. Sign in again to continue.',
  INVALID_CREDENTIALS: "That email and password don't match. Check them and try again.",
  CSRF_REJECTED: 'That request could not be verified. Reload the page and try again.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
} as const satisfies Record<ErrorCode, string>;

/** Body of every JSON error response from `/api`; `requestId` matches a log line. */
export const ApiErrorBody = z
  .object({
    error: z
      .object({
        code: z.enum(ErrorCode),
        message: z.string().min(1),
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
