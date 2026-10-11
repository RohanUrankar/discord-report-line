import { describe, expect, it } from 'vitest';

import { ApiErrorBody, ErrorCode, errorMessages } from './index.js';

describe('shared API errors', () => {
  it('has a non-empty default message for every error code', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(errorMessages[code].length).toBeGreaterThan(0);
    }
  });

  it('accepts the documented error body shape', () => {
    const body = {
      error: { code: 'NOT_FOUND', message: errorMessages.NOT_FOUND, requestId: 'req-1' },
    };
    expect(ApiErrorBody.safeParse(body).success).toBe(true);
  });

  it('rejects an error body without a request id or with unknown keys', () => {
    expect(
      ApiErrorBody.safeParse({ error: { code: 'INTERNAL', message: 'x' } }).success,
    ).toBe(false);
    expect(
      ApiErrorBody.safeParse({
        error: { code: 'INTERNAL', message: 'x', requestId: 'r', stack: 's' },
      }).success,
    ).toBe(false);
  });
});
