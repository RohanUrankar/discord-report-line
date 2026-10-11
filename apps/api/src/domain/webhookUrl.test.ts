import { describe, expect, it } from 'vitest';

import { isAllowedWebhookUrl } from './webhookUrl.js';

const PREFIX = 'https://hooks.slack.com/services/';

describe('isAllowedWebhookUrl', () => {
  it('accepts a Slack incoming webhook URL', () => {
    expect(isAllowedWebhookUrl(`${PREFIX}T000/B000/xxxx`, PREFIX)).toBe(true);
  });

  it.each([
    ['plain http', 'http://hooks.slack.com/services/T000/B000/xxxx'],
    ['another host', 'https://example.com/services/T000/B000/xxxx'],
    ['a look-alike host', 'https://hooks.slack.com.evil.test/services/T000/B000/xxxx'],
    ['credentials in the URL', 'https://user:pass@hooks.slack.com/services/T000/B000/xxxx'],
    ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'http://localhost:5432/services/x'],
    ['another path on the host', 'https://hooks.slack.com/other/T000/B000/xxxx'],
    ['the prefix alone', PREFIX],
    ['empty text', ''],
    ['not a URL', 'not a url'],
    ['a space inside', `${PREFIX}T000/B000/xx xx`],
    [
      'a line break inside',
      `${PREFIX}T000/B000/xx
xx`,
    ],
    ['a tab inside', `${PREFIX}T000/B000/xx	xx`],
    ['non-ASCII letters', `${PREFIX}T000/B000/xxé`],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedWebhookUrl(url, PREFIX)).toBe(false);
  });

  it('accepts a stub prefix when the operator configures one', () => {
    const stub = 'http://127.0.0.1:5555/services/';
    expect(isAllowedWebhookUrl(`${stub}T/B/x`, stub)).toBe(true);
    expect(isAllowedWebhookUrl(`${PREFIX}T/B/x`, stub)).toBe(false);
  });
});
