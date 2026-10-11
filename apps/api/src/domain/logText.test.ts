import { describe, expect, it } from 'vitest';

import { MAX_LOG_TEXT_LENGTH, readableLogText } from './logText.js';

describe('readableLogText', () => {
  it('WHEN there is no text THE SYSTEM SHALL return null', () => {
    expect(readableLogText(null)).toBeNull();
  });

  it('WHEN the worker wrote a normal sentence THE SYSTEM SHALL leave it untouched', () => {
    const sentence =
      'Slack says the webhook no longer exists (HTTP 404). Set a new webhook URL on the dashboard.';
    expect(readableLogText(sentence)).toBe(sentence);
  });

  it.each([
    ['a full webhook URL', 'POST https://hooks.slack.com/services/T000/B000/SECRETVALUE failed'],
    ['a URL on any host', 'fetch failed for http://127.0.0.1:9000/services/T0/B0/SECRETVALUE'],
    ['a bare webhook host', 'bad host hooks.slack.com/services/T0/B0/SECRETVALUE'],
    ['a webhook path alone', 'path /services/T0/B0/SECRETVALUE rejected'],
  ])('WHEN the text contains %s THE SYSTEM SHALL remove the link', (_name, text) => {
    const cleaned = readableLogText(text);

    expect(cleaned).not.toContain('SECRETVALUE');
    expect(cleaned).toContain('[link removed]');
  });

  it('WHEN the text is longer than the limit THE SYSTEM SHALL cut it', () => {
    expect(readableLogText('x'.repeat(MAX_LOG_TEXT_LENGTH + 50))).toHaveLength(MAX_LOG_TEXT_LENGTH);
  });

  it('WHEN the text is exactly the limit THE SYSTEM SHALL keep all of it', () => {
    expect(readableLogText('x'.repeat(MAX_LOG_TEXT_LENGTH))).toHaveLength(MAX_LOG_TEXT_LENGTH);
  });
});
