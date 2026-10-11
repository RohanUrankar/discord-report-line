import { describe, expect, it } from 'vitest';

import { escapeSlackText, mirrorMessage } from './mirrorMessage.js';

const USER = '900000000000000003';
const CHANNEL = '900000000000000002';

describe('escapeSlackText', () => {
  it.each([
    ['<!channel>', '&lt;!channel&gt;'],
    ['<!here>', '&lt;!here&gt;'],
    ['<@U123>', '&lt;@U123&gt;'],
    ['<https://evil.test|click here>', '&lt;https://evil.test|click here&gt;'],
    ['fish & chips', 'fish &amp; chips'],
    ['&lt; already', '&amp;lt; already'],
    ['plain text', 'plain text'],
  ])('turns %j into %j', (input, expected) => {
    expect(escapeSlackText(input)).toBe(expected);
  });
});

describe('mirrorMessage', () => {
  it('leads with what happened, then who and where, then the report', () => {
    expect(mirrorMessage({ text: 'printer is on fire', userId: USER, channelId: CHANNEL })).toBe(
      `🆕 New report from Discord user ${USER} in channel ${CHANNEL}: “printer is on fire”`,
    );
  });

  it('SHALL escape mentions and links in the report so Slack cannot ping or link from user text', () => {
    const text = mirrorMessage({
      text: 'hi <!channel> <@U123> <https://evil.test|ok>',
      userId: USER,
      channelId: CHANNEL,
    });

    expect(text).toContain('&lt;!channel&gt;');
    expect(text).toContain('&lt;@U123&gt;');
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U123>');
    expect(text).not.toContain('<https');
  });

  it('SHALL keep an over-long report within the report limit', () => {
    const text = mirrorMessage({ text: 'a'.repeat(5000), userId: USER, channelId: CHANNEL });

    expect(text.length).toBeLessThan(1200);
  });
});
