import { z } from 'zod';

// Limits are on every string (backend-guidelines). The password cap is far above any real password and
// exists so a hostile body cannot make the server hash megabytes.
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 256;

/** `POST /api/auth/login`. Strict: unknown keys are rejected, not carried along. */
export const LoginRequest = z
  .object({
    // Normalised here so the service and the stored (lower-cased) email agree on what "the same email" means.
    email: z.string().trim().toLowerCase().pipe(z.email().max(MAX_EMAIL_LENGTH)),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequest>;

/**
 * Response of `POST /api/auth/login` and `GET /api/auth/me`. The session itself is the HttpOnly cookie and is
 * never visible to the SPA; `csrfToken` is what the SPA echoes back in the `X-CSRF-Token` header on every
 * request that is not a GET.
 */
export const SessionInfo = z
  .object({
    admin: z.object({ id: z.uuid(), email: z.string().min(1) }).strict(),
    csrfToken: z.string().min(1),
  })
  .strict();
export type SessionInfo = z.infer<typeof SessionInfo>;

export const CSRF_HEADER = 'x-csrf-token';
