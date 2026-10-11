import { ErrorCode, errorMessages, RULE_SCHEMAS } from '@report-line/shared';

describe('shared contract import', () => {
  it('resolves @report-line/shared in the Angular build and test toolchain', () => {
    expect(errorMessages[ErrorCode.UNAUTHENTICATED]).toContain('Sign in');
    expect(Object.keys(RULE_SCHEMAS)).toEqual(['status', 'report']);
  });
});
