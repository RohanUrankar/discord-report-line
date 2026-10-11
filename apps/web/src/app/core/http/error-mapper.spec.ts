import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

import { errorBody } from '../../../testing/fixtures';
import { parseRetryAfter, toAppError } from './error-mapper';

const failure = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpErrorResponse =>
  new HttpErrorResponse({ status, error: body, headers: new HttpHeaders(headers) });

describe('toAppError', () => {
  it('maps the server error body to a code, shared wording, the reference and the field paths', () => {
    const error = toAppError(
      failure(
        400,
        errorBody('VALIDATION_FAILED', {
          fields: ['mirrorWebhookUrl', '(root)'],
          requestId: 'r-9',
        }),
      ),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('Some fields need attention. Check them and try again.');
    expect(error.requestId).toBe('r-9');
    expect(error.fields).toEqual(['mirrorWebhookUrl', '(root)']);
  });

  it('never uses the wording the server sent: the code decides', () => {
    expect(toAppError(failure(404, errorBody('NOT_FOUND'))).message).not.toContain(
      'server wording',
    );
  });

  it('WHEN the call is rate limited THE UI SHALL read Retry-After', () => {
    const error = toAppError(failure(429, errorBody('RATE_LIMITED'), { 'Retry-After': '42' }));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterSeconds).toBe(42);
  });

  it('WHEN there is no connection (status 0) THE UI SHALL report NETWORK', () => {
    expect(toAppError(failure(0, new ProgressEvent('error'))).code).toBe('NETWORK');
  });

  it('classifies a reply that is not our error body (a proxy page) by status alone', () => {
    expect(toAppError(failure(502, '<html>Bad gateway</html>')).code).toBe('INTERNAL');
    expect(toAppError(failure(401, '')).code).toBe('UNAUTHENTICATED');
    expect(toAppError(failure(404, null)).code).toBe('NOT_FOUND');
  });

  it('ignores a body with an unknown code instead of trusting it', () => {
    expect(toAppError(failure(500, errorBody('MADE_UP'))).code).toBe('INTERNAL');
  });
});

describe('parseRetryAfter', () => {
  it('reads whole seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter(' 5 ')).toBe(5);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(parseRetryAfter('Mon, 12 Oct 2026 10:01:00 GMT', now)).toBe(60);
  });

  it('gives up on anything else', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});
