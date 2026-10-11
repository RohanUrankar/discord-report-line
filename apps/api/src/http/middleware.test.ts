import { describe, expect, it } from 'vitest';

import { LogSink } from '../../test/helpers/logging.js';
import { createLogger, REDACT_PATHS } from './middleware.js';

const SECRET = 'SECRET-VALUE-must-not-be-logged';

/** Builds `{a: {b: {c: SECRET}}}` for the path `a.b.c`; a `*` segment becomes an arbitrary key. */
function objectAtPath(path: string): Record<string, unknown> {
  return path
    .split('.')
    .reverse()
    .reduce<unknown>(
      (inner, segment) => ({ [segment === '*' ? 'anyKey' : segment]: inner }),
      SECRET,
    ) as Record<string, unknown>;
}

describe('log redaction (ADR-0005)', () => {
  it.each(REDACT_PATHS)('redacts %s', (path) => {
    const sink = new LogSink();
    const logger = createLogger('info', sink);

    logger.info(objectAtPath(path), 'test.event');

    expect(sink.text()).not.toContain(SECRET);
    expect(sink.text()).toContain('[redacted]');
  });

  it('covers the interaction token and authorization header explicitly', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'token',
        '*.token',
        'interaction_token',
        'req.headers.authorization',
      ]),
    );
  });

  it.each([
    ['a job row', { job: { id: 'j1', interaction_token: SECRET } }],
    ['a ledger input', { input: { job: { kind: 'report', interactionToken: SECRET } } }],
  ])('redacts the interaction token inside %s', (_name, fields) => {
    const sink = new LogSink();

    createLogger('info', sink).info(fields, 'test.event');

    expect(sink.text()).not.toContain(SECRET);
  });

  it('redacts a token carried on a child logger binding', () => {
    const sink = new LogSink();
    const child = createLogger('info', sink).child({ interaction_id: '1', token: SECRET });

    child.info({}, 'test.event');

    expect(sink.text()).not.toContain(SECRET);
    expect(sink.records()[0]).toMatchObject({ interaction_id: '1' });
  });

  it('keeps ordinary correlation fields readable', () => {
    const sink = new LogSink();

    createLogger('info', sink).info(
      { interaction_id: '42', guild_id: '7' },
      'interaction.received',
    );

    expect(sink.records()[0]).toMatchObject({
      msg: 'interaction.received',
      interaction_id: '42',
      guild_id: '7',
    });
  });

  it('respects the configured level', () => {
    const sink = new LogSink();
    createLogger('warn', sink).info({}, 'too.quiet');
    expect(sink.lines).toEqual([]);
  });
});
