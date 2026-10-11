import type { Request, Response } from 'express';

export interface SessionCookieSettings {
  /**
   * The cookie's Secure attribute. The config default is true; only an explicit
   * SESSION_COOKIE_SECURE=false (plain-http local development) turns it off.
   */
  secure: boolean;
  /** Matches the server-side session lifetime, so the browser drops the cookie when the session ends. */
  ttlMs: number;
}

// The `__Host-` prefix makes browsers refuse a cookie that is not Secure, has a Domain, or is not on `/`, which
// stops a sibling subdomain planting a session. It requires Secure, so the plain name is used for http dev.
const SECURE_COOKIE_NAME = '__Host-session';
const PLAIN_COOKIE_NAME = 'session';

export function sessionCookieName(settings: SessionCookieSettings): string {
  return settings.secure ? SECURE_COOKIE_NAME : PLAIN_COOKIE_NAME;
}

/** The session id the browser sent, if any. Only the exact cookie name counts; the value is validated later. */
export function readSessionCookie(
  req: Request,
  settings: SessionCookieSettings,
): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  const wanted = sessionCookieName(settings);
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === wanted) {
      values.push(part.slice(separator + 1).trim());
    }
  }
  // Two cookies with the session's name (a sibling domain can plant one) make the browser's choice ambiguous:
  // trust neither, whatever the order, and the caller sees "no session".
  return values.length === 1 ? values[0] : undefined;
}

function attributes(settings: SessionCookieSettings): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
} {
  return { httpOnly: true, secure: settings.secure, sameSite: 'lax', path: '/' };
}

export function setSessionCookie(
  res: Response,
  settings: SessionCookieSettings,
  sessionId: string,
): void {
  res.cookie(sessionCookieName(settings), sessionId, {
    ...attributes(settings),
    maxAge: settings.ttlMs,
  });
}

export function clearSessionCookie(res: Response, settings: SessionCookieSettings): void {
  res.clearCookie(sessionCookieName(settings), attributes(settings));
}
