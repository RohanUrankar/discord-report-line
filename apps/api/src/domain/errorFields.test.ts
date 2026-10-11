import { describe, expect, it } from 'vitest';

import { errorLogFields } from './errorFields.js';

describe('errorLogFields', () => {
  it('keeps the name and a string code', () => {
    const error = Object.assign(new TypeError('boom'), { code: 'ECONNREFUSED' });
    expect(errorLogFields(error)).toEqual({ errorName: 'TypeError', errorCode: 'ECONNREFUSED' });
  });

  it('omits the code when there is none or it is not a string', () => {
    expect(errorLogFields(new Error('x'))).toEqual({ errorName: 'Error' });
    expect(errorLogFields(Object.assign(new Error('x'), { code: 5 }))).toEqual({
      errorName: 'Error',
    });
  });

  it('never exposes the message or detail, which can quote a row holding the interaction token', () => {
    const error = Object.assign(new Error('Failing row contains (tok-SECRET)'), {
      code: '23514',
      detail: 'Failing row contains (tok-SECRET)',
    });
    expect(JSON.stringify(errorLogFields(error))).not.toContain('SECRET');
  });

  it('describes a thrown non-Error without inspecting it', () => {
    expect(errorLogFields('tok-SECRET')).toEqual({ errorName: 'NonError' });
    expect(errorLogFields(undefined)).toEqual({ errorName: 'NonError' });
  });
});
