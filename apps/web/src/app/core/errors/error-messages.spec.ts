import { ErrorCode, errorMessages } from '@report-line/shared';

import { formatWait, messageForCode, rateLimitedMessage } from './error-messages';

describe('error messages', () => {
  it('WHEN a server error code arrives THE UI SHALL use the shared message for that code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(messageForCode(code)).toBe(errorMessages[code]);
    }
  });

  it('WHEN the server cannot be reached THE UI SHALL say so in plain words', () => {
    expect(messageForCode('NETWORK')).toMatch(/can't reach the server/i);
  });

  it('falls back to the generic message for a code this build does not know', () => {
    expect(messageForCode('SOMETHING_NEW' as never)).toBe(errorMessages.INTERNAL);
  });

  it.each([
    [1, '1 second'],
    [42, '42 seconds'],
    [60, '1 minute'],
    [125, '2 minutes 5 seconds'],
    [0, '1 second'],
    [41.2, '42 seconds'],
  ])('formats a wait of %s seconds as "%s"', (seconds, text) => {
    expect(formatWait(seconds)).toBe(text);
  });

  it('WHEN the server says how long to wait THE UI SHALL show that exact wait', () => {
    expect(rateLimitedMessage(42)).toBe('Too many attempts. Try again in 42 seconds.');
    expect(rateLimitedMessage(null)).toBe(errorMessages.RATE_LIMITED);
  });
});
