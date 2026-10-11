import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { defineConfig } from 'vitest/config';

// The test database URLs come from the process environment or the gitignored root .env. Only these two
// names are forwarded to the tests, so nothing else in .env (the bot token, say) reaches a test process.
const FORWARDED = ['DATABASE_URL_TEST', 'DATABASE_URL'] as const;

function forwardedEnv(): Record<string, string> {
  let fromFile: Record<string, string | undefined> = {};
  try {
    fromFile = parseEnv(readFileSync(path.resolve(import.meta.dirname, '../../.env'), 'utf8'));
  } catch {
    // No .env file: the variables may still be in the process environment.
  }
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = process.env[name] ?? fromFile[name];
    if (value !== undefined && value !== '') {
      forwarded[name] = value;
    }
  }
  return forwarded;
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: forwardedEnv(),
    // DB tests share one database and truncate it, so test files must not overlap.
    fileParallelism: false,
  },
});
