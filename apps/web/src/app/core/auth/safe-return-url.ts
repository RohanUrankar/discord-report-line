const MAX_RETURN_URL_LENGTH = 2000;
const PROBE_ORIGIN = 'https://probe.invalid';
const LOGIN_PATH = /^\/login(?:[/?#]|$)/;

/**
 * A return URL comes from the query string, so it is attacker-controlled. It is only ever used for in-app
 * navigation after sign-in, and only if it is a plain absolute path of this app: no scheme, no host
 * (`//evil.example`), no backslash tricks, no control characters, and not the sign-in page itself.
 * Returns the cleaned path, or null.
 */
export function safeReturnUrl(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return null;
  }
  if (candidate.length > MAX_RETURN_URL_LENGTH) {
    return null;
  }
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\s]/.test(candidate)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== PROBE_ORIGIN) {
    return null;
  }
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return LOGIN_PATH.test(path) ? null : path;
}
