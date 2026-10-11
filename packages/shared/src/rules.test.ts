import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES, RULE_SCHEMAS, ReportRuleConfig, StatusRuleConfig } from './index.js';

const VALID_REPORT = {
  version: 1,
  ephemeral: false,
  replyMessage: 'Thanks, we are on it.',
  mirror: true,
  tag: true,
};

describe('StatusRuleConfig', () => {
  it('accepts a valid status rule', () => {
    expect(StatusRuleConfig.safeParse({ version: 1, ephemeral: false }).success).toBe(true);
  });

  it('rejects unknown keys (.strict())', () => {
    expect(StatusRuleConfig.safeParse({ version: 1, ephemeral: true, mirror: true }).success).toBe(
      false,
    );
  });

  it('rejects a version other than 1', () => {
    expect(StatusRuleConfig.safeParse({ version: 2, ephemeral: true }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(StatusRuleConfig.safeParse({ version: 1 }).success).toBe(false);
  });
});

describe('ReportRuleConfig', () => {
  it('accepts a valid report rule', () => {
    expect(ReportRuleConfig.safeParse(VALID_REPORT).success).toBe(true);
  });

  it('trims replyMessage', () => {
    const parsed = ReportRuleConfig.parse({ ...VALID_REPORT, replyMessage: '  Logged.  ' });
    expect(parsed.replyMessage).toBe('Logged.');
  });

  it('accepts a replyMessage of exactly 300 characters', () => {
    expect(
      ReportRuleConfig.safeParse({ ...VALID_REPORT, replyMessage: 'a'.repeat(300) }).success,
    ).toBe(true);
  });

  it('rejects a replyMessage of 301 characters', () => {
    expect(
      ReportRuleConfig.safeParse({ ...VALID_REPORT, replyMessage: 'a'.repeat(301) }).success,
    ).toBe(false);
  });

  it('rejects an empty or whitespace-only replyMessage', () => {
    expect(ReportRuleConfig.safeParse({ ...VALID_REPORT, replyMessage: '' }).success).toBe(false);
    expect(ReportRuleConfig.safeParse({ ...VALID_REPORT, replyMessage: '   ' }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys (.strict())', () => {
    expect(ReportRuleConfig.safeParse({ ...VALID_REPORT, webhookUrl: 'x' }).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(ReportRuleConfig.safeParse({ ...VALID_REPORT, mirror: 'yes' }).success).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(ReportRuleConfig.safeParse(null).success).toBe(false);
    expect(ReportRuleConfig.safeParse('[]').success).toBe(false);
  });
});

describe('DEFAULT_RULES', () => {
  it('every default validates against its own schema', () => {
    expect(RULE_SCHEMAS.status.safeParse(DEFAULT_RULES.status).success).toBe(true);
    expect(RULE_SCHEMAS.report.safeParse(DEFAULT_RULES.report).success).toBe(true);
  });

  it('has a default for every command that has a schema', () => {
    expect(Object.keys(DEFAULT_RULES).sort()).toEqual(Object.keys(RULE_SCHEMAS).sort());
  });
});
