import { z } from 'zod';

/** Stable, machine-readable API error codes. The dashboard switches on these (resilience skill). */
export const ErrorCode = {
  INTERNAL: 'INTERNAL',
  NOT_FOUND: 'NOT_FOUND',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Default user-facing text per code (user-facing-messages skill): what happened and what to do. */
export const errorMessages = {
  INTERNAL: 'Something went wrong on our side. Please try again.',
  NOT_FOUND: "We couldn't find that.",
} as const satisfies Record<ErrorCode, string>;

/** Body of every JSON error response from `/api`; `requestId` matches a log line. */
export const ApiErrorBody = z
  .object({
    error: z
      .object({
        code: z.enum([ErrorCode.INTERNAL, ErrorCode.NOT_FOUND]),
        message: z.string().min(1),
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
