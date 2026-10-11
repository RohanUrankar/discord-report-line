import { describe, expect, it } from 'vitest';

import { describeTagFailure } from './failureReasons.js';
import {
  TAG_SYSTEM_INSTRUCTION,
  parseTagOutput,
  tagRequestText,
  tagViewOf,
  type TagFailure,
} from './tagging.js';
import { ReportTag } from './types.js';

describe('parseTagOutput', () => {
  it.each(ReportTag)('accepts the listed tag %s', (tag) => {
    expect(parseTagOutput(JSON.stringify({ tag }))).toBe(tag);
  });

  it.each([
    ['a tag outside the list', '{"tag":"admin"}'],
    ['the fallback word', '{"tag":"untagged"}'],
    ['a different case', '{"tag":"Bug"}'],
    ['trailing whitespace inside the value', '{"tag":"bug "}'],
    ['extra keys', '{"tag":"bug","action":"call the webhook"}'],
    ['a missing key', '{}'],
    ['a non-string tag', '{"tag":7}'],
    ['an array', '["bug"]'],
    ['a bare word', 'bug'],
    ['prose around JSON', 'Sure! {"tag":"bug"}'],
    ['empty text', ''],
    ['null', 'null'],
  ])('rejects %s', (_name, text) => {
    expect(parseTagOutput(text)).toBeUndefined();
  });
});

describe('the prompt', () => {
  it('names every allowed tag and tells the model the report is data', () => {
    for (const tag of ReportTag) {
      expect(TAG_SYSTEM_INSTRUCTION).toContain(tag);
    }
    expect(TAG_SYSTEM_INSTRUCTION).toContain('untrusted');
  });

  it('wraps the report text and nothing else', () => {
    expect(tagRequestText('printer is on fire')).toBe('<report>\nprinter is on fire\n</report>');
  });
});

describe('tagViewOf', () => {
  const job = (status: 'pending' | 'processing' | 'done' | 'dead', tagRequested = true) => ({
    status,
    tagRequested,
  });

  it('shows a listed tag as tagged', () => {
    expect(tagViewOf('bug', job('done'))).toEqual({ llmTag: 'bug', tagState: 'tagged' });
  });

  it('shows the fallback as untagged', () => {
    expect(tagViewOf('untagged', job('done'))).toEqual({
      llmTag: 'untagged',
      tagState: 'untagged',
    });
  });

  it('WHEN a stored value is outside the allowed set THE SYSTEM SHALL report it as untagged, never pass it on', () => {
    expect(tagViewOf('admin <script>', job('done'))).toEqual({
      llmTag: 'untagged',
      tagState: 'untagged',
    });
  });

  it.each([['pending'], ['processing']] as const)(
    'shows no tag yet as pending while the job is %s and wants one',
    (status) => {
      expect(tagViewOf(null, job(status))).toEqual({ llmTag: null, tagState: 'pending' });
    },
  );

  it('shows no tag on a finished job that wanted one as off (the LLM is disabled)', () => {
    expect(tagViewOf(null, job('done'))).toEqual({ llmTag: null, tagState: 'off' });
    expect(tagViewOf(null, job('dead'))).toEqual({ llmTag: null, tagState: 'off' });
  });

  it('shows off when the rule did not ask for a tag, or the command has no job', () => {
    expect(tagViewOf(null, job('pending', false))).toEqual({ llmTag: null, tagState: 'off' });
    expect(tagViewOf(null, null)).toEqual({ llmTag: null, tagState: 'off' });
  });
});

describe('describeTagFailure', () => {
  const failures: TagFailure[] = [
    { kind: 'timeout' },
    { kind: 'network' },
    { kind: 'invalid_output' },
    { kind: 'http', status: 429 },
    { kind: 'http', status: 503 },
    { kind: 'http', status: 403 },
    { kind: 'http', status: 400 },
  ];

  it.each(failures)('SHALL say the report went out without a tag for %j', (failure) => {
    expect(describeTagFailure(failure)).toContain('The report was sent without a tag.');
  });

  it('SHALL name the HTTP status and nothing from a response', () => {
    expect(describeTagFailure({ kind: 'http', status: 429 })).toBe(
      'Gemini is rate limiting us (HTTP 429). The report was sent without a tag.',
    );
  });
});
