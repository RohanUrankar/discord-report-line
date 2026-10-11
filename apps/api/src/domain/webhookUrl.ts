/**
 * Whether `url` may be used as a server's Slack webhook (security-secrets: SSRF). It must start with the
 * configured prefix (default `https://hooks.slack.com/services/`), parse as a URL, and carry no credentials.
 * The prefix pins scheme, host, port and path in one comparison. Checked when the URL is saved AND again just
 * before it is called, because a stored value can be edited in the database.
 */
export function isAllowedWebhookUrl(url: string, allowedPrefix: string): boolean {
  if (!url.startsWith(allowedPrefix) || url.length === allowedPrefix.length) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
