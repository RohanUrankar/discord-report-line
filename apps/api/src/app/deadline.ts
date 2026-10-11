export class DeadlineExceededError extends Error {
  public constructor(ms: number) {
    super(`Deadline of ${String(ms)} ms exceeded`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Settles with `work`, or rejects once `ms` have passed, whichever comes first. This does not cancel `work`;
 * it bounds how long the caller waits, which is what the 3 s Discord clock needs (CLAUDE.md).
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError(ms));
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
