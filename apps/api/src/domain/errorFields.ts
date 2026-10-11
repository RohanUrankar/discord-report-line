/** The only facts about a failure that are safe to put in a log line. */
export interface ErrorLogFields {
  errorName: string;
  /** Postgres SQLSTATE (`23505`) or a Node system code (`ECONNREFUSED`), when the error has one. */
  errorCode?: string;
}

/**
 * Name and code, never the message, `detail` or stack. A Postgres error's message and detail quote the
 * failing row and the query, and a job row holds the interaction token (CLAUDE.md: Secrets).
 */
export function errorLogFields(error: unknown): ErrorLogFields {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError' };
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined
    ? { errorName: error.name }
    : { errorName: error.name, errorCode: code };
}
