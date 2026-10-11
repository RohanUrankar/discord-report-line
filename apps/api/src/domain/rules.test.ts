import { DEFAULT_RULES } from '@report-line/shared';
import { describe, expect, it } from 'vitest';

import { ROOT_FIELD, evaluate, isCommandName, loggableFields, validateRule } from './rules.js';

const ENABLED = { enabled: true };
const VALID_REPORT = {
  version: 1,
  ephemeral: false,
  replyMessage: 'Thanks, we are on it.',
  mirror: false,
  tag: true,
};

describe('validateRule', () => {
  it('accepts a valid report rule and returns the parsed config', () => {
    expect(validateRule('report', VALID_REPORT)).toEqual({ ok: true, rule: VALID_REPORT });
  });

  it('accepts a valid status rule', () => {
    expect(validateRule('status', { version: 1, ephemeral: false })).toEqual({
      ok: true,
      rule: { version: 1, ephemeral: false },
    });
  });

  it('returns the trimmed replyMessage', () => {
    const result = validateRule('report', { ...VALID_REPORT, replyMessage: '  Logged.  ' });
    expect(result).toEqual({ ok: true, rule: { ...VALID_REPORT, replyMessage: 'Logged.' } });
  });

  it('WHEN the command is unknown THE SYSTEM SHALL report the command field', () => {
    expect(validateRule('ban', VALID_REPORT)).toEqual({ ok: false, fields: ['command'] });
  });

  it('does not treat inherited object keys as command names', () => {
    expect(validateRule('__proto__', {})).toEqual({ ok: false, fields: ['command'] });
    expect(validateRule('toString', {})).toEqual({ ok: false, fields: ['command'] });
  });

  it('WHEN a saved rule is malformed THE SYSTEM SHALL reject it with field paths', () => {
    const result = validateRule('report', { ...VALID_REPORT, replyMessage: '', mirror: 'yes' });
    expect(result).toEqual({ ok: false, fields: ['replyMessage', 'mirror'] });
  });

  it('names an unknown key as a field instead of echoing its value', () => {
    const result = validateRule('status', { version: 1, ephemeral: true, webhook: 'secret-value' });
    expect(result).toEqual({ ok: false, fields: ['webhook'] });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('never echoes the offending value', () => {
    const result = validateRule('report', { ...VALID_REPORT, replyMessage: 'x'.repeat(301) });
    expect(JSON.stringify(result)).not.toContain('xxx');
  });

  it('reports the root when the config is not an object', () => {
    expect(validateRule('report', 'not an object')).toEqual({ ok: false, fields: [ROOT_FIELD] });
    expect(validateRule('report', null)).toEqual({ ok: false, fields: [ROOT_FIELD] });
  });

  it('never throws on hostile input', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => validateRule('report', hostile)).not.toThrow();
    expect(validateRule('report', hostile).ok).toBe(false);
  });
});

describe('evaluate', () => {
  it('returns unknown_command for a command with no schema', () => {
    expect(evaluate('ban', ENABLED, null)).toEqual({ type: 'unknown_command' });
  });

  it('checks the command before the enabled switch', () => {
    expect(evaluate('ban', { enabled: false }, null)).toEqual({ type: 'unknown_command' });
  });

  it('returns disabled when the command is switched off', () => {
    expect(evaluate('report', { enabled: false }, VALID_REPORT)).toEqual({ type: 'disabled' });
  });

  it('uses the stored config when it is valid', () => {
    expect(evaluate('report', ENABLED, VALID_REPORT)).toEqual({
      type: 'report',
      ...withoutVersion(VALID_REPORT),
    });
  });

  it('uses DEFAULT_RULES when there is no row', () => {
    expect(evaluate('report', ENABLED, null)).toEqual({
      type: 'report',
      ...withoutVersion(DEFAULT_RULES.report),
    });
    expect(evaluate('status', ENABLED, null)).toEqual({ type: 'status', ephemeral: true });
  });

  it('WHEN a stored rule is invalid at runtime THE SYSTEM SHALL fall back to the default and not crash', () => {
    expect(evaluate('report', ENABLED, { version: 99, garbage: true })).toEqual({
      type: 'report',
      ...withoutVersion(DEFAULT_RULES.report),
    });
  });

  it('falls back to the default for a non-object stored rule', () => {
    expect(evaluate('status', ENABLED, 'corrupt')).toEqual({ type: 'status', ephemeral: true });
  });

  it('applies a valid status rule', () => {
    expect(evaluate('status', ENABLED, { version: 1, ephemeral: false })).toEqual({
      type: 'status',
      ephemeral: false,
    });
  });
});

describe('isCommandName', () => {
  it('accepts the registered commands only', () => {
    expect(isCommandName('report')).toBe(true);
    expect(isCommandName('status')).toBe(true);
    expect(isCommandName('Report')).toBe(false);
    expect(isCommandName('constructor')).toBe(false);
  });
});

function withoutVersion<T extends { version: number }>(rule: T): Omit<T, 'version'> {
  const { version: _version, ...rest } = rule;
  return rest;
}

describe('loggableFields', () => {
  it('keeps the fields a rule defines and reports an invented key by its parent only', () => {
    expect(loggableFields(['replyMessage', 'mirror', 'secret-key-name', ROOT_FIELD])).toEqual([
      'replyMessage',
      'mirror',
      ROOT_FIELD,
    ]);
  });
});
