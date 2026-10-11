import type { z } from 'zod';

/** Field path reported when the problem is the value as a whole (not an object, wrong shape). */
export const ROOT_FIELD = '(root)';

/**
 * The paths of the fields a zod error complains about, deduplicated, and nothing else. Never a message or a
 * value: the message of some checks quotes the input, and what an admin typed may be a secret (a webhook URL).
 */
export function fieldPaths(issues: readonly z.core.$ZodIssue[]): string[] {
  const paths = issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => [...issue.path.map(String), key].join('.'));
    }
    return [issue.path.length === 0 ? ROOT_FIELD : issue.path.map(String).join('.')];
  });
  return [...new Set(paths)];
}

/**
 * Keeps only paths a client may be told about. A path is a field the API itself defines (`known`), or its
 * nearest known parent; anything else (the name of an unknown key an admin sent) becomes the parent or
 * `(root)`, so an error response never reflects text the caller chose.
 */
export function publicFieldPaths(paths: readonly string[], known: ReadonlySet<string>): string[] {
  const shown = paths.map((path) => {
    let candidate = path;
    while (!known.has(candidate)) {
      const cut = candidate.lastIndexOf('.');
      if (cut < 0) {
        return ROOT_FIELD;
      }
      candidate = candidate.slice(0, cut);
    }
    return candidate;
  });
  return [...new Set(shown)];
}
