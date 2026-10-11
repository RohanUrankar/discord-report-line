import { describe, expect, it } from 'vitest';

import { DeadlineExceededError, withDeadline } from './deadline.js';

describe('withDeadline', () => {
  it('returns the value when the work finishes in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects with DeadlineExceededError when the work never settles', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withDeadline(never, 10)).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('passes the work failure through unchanged', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });
});
