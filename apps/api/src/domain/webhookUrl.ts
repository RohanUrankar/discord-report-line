/** Visible ASCII only: a URL with spaces, control characters or look-alike letters is not one we issued. */
const PLAIN_URL_TEXT = /^[!-~]+$/;

/**
 * Whether `url` may be used as a server's Slack webhook (security-secrets: SSRF). It must start with the
 * configured prefix (default `https://hooks.slack.com/services/`), parse as a URL, and carry no credentials.
 * The prefix pins scheme, host, port and path in one comparison. Checked when the URL is saved AND again just
 * before it is called, because a stored value can be edited in the database.
 */
export function isAllowedWebhookUrl(url: string, allowedPrefix: string): boolean {
  if (
    !PLAIN_URL_TEXT.test(url) ||
    !url.startsWith(allowedPrefix) ||
    url.length === allowedPrefix.length
  ) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
