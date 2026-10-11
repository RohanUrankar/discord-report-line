import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// F: `.env.example` is the operator's only list of settings, so it must name every variable the code reads and
// must hold placeholders, not values. The code's variables are found two ways: the keys of the schemas in
// config.ts (the only module allowed to read the environment) and any direct `process.env.NAME` elsewhere.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative: string): string =>
  readFileSync(path.join(ROOT, relative), 'utf8');

/** Variables only docker-compose.yml reads (the Compose container), not the application. */
const COMPOSE_ONLY = ['POSTGRES_PASSWORD', 'POSTGRES_PORT'];

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => path.join(dir, file));
}

function variablesReadByCode(): Set<string> {
  const names = new Set<string>();
  for (const match of read('apps/api/src/config.ts').matchAll(/^\s{2,4}([A-Z][A-Z0-9_]{2,}):/gm)) {
    names.add(match[1] ?? '');
  }
  const files = [
    ...sourceFiles('apps/api/src'),
    ...sourceFiles('apps/api/test'),
    ...sourceFiles('scripts'),
  ];
  for (const file of files.filter(
    (f) => !f.endsWith('config.ts') && !f.endsWith('envExample.test.ts'),
  )) {
    for (const match of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
      names.add(match[1] ?? '');
    }
  }
  return names;
}

function variablesInExample(): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=(.*)$/gm)) {
    found.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return found;
}

describe('.env.example', () => {
  it('WHEN the code reads an environment variable THE SYSTEM SHALL list it in .env.example', () => {
    const listed = variablesInExample();
    const missing = [...variablesReadByCode()].filter((name) => !listed.has(name));

    expect(missing).toEqual([]);
  });

  it('SHALL not list a variable that nothing reads (other than the Compose-only ones)', () => {
    const read_ = variablesReadByCode();
    const stale = [...variablesInExample().keys()].filter(
      (name) => !read_.has(name) && !COMPOSE_ONLY.includes(name),
    );

    expect(stale).toEqual([]);
  });

  it('SHALL have found the variables it checks (guards against a regex that matches nothing)', () => {
    const names = variablesReadByCode();
    for (const expected of [
      'DISCORD_PUBLIC_KEY',
      'DATABASE_URL',
      'GEMINI_API_KEY',
      'LLM_ENABLED',
      'DATABASE_URL_TEST',
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
  });

  it('SHALL hold placeholders for every secret, never a real-looking value', () => {
    const listed = variablesInExample();
    const secrets = [
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'WEBHOOK_ENC_KEY',
      'SESSION_SECRET',
      'ADMIN_PASSWORD',
      'POSTGRES_PASSWORD',
      'GEMINI_API_KEY',
    ];
    for (const name of secrets) {
      expect(listed.get(name), name).toMatch(/replace|placeholder|example/i);
    }
    expect(listed.get('DATABASE_URL')).toContain('replace-with-password');
    expect(listed.get('DATABASE_URL_TEST')).toContain('replace-with-password');
  });

  it('SHALL not contain anything shaped like a token, key or webhook URL', () => {
    const text = read('.env.example');

    expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(text).not.toMatch(/[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/);
    expect(text).not.toMatch(/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B/);
    expect(text).not.toMatch(/\b[0-9a-fA-F]{64}\b/);
    expect(text).not.toMatch(/\$argon2/);
  });
});
