import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ROOT_FIELD, fieldPaths, publicFieldPaths } from './fieldPaths.js';

const Body = z.object({ name: z.string(), inner: z.object({ n: z.number() }).strict() }).strict();

function pathsOf(input: unknown): string[] {
  const result = Body.safeParse(input);
  return result.success ? [] : fieldPaths(result.error.issues);
}

describe('fieldPaths', () => {
  it('WHEN fields are wrong THE SYSTEM SHALL report dotted paths and no values', () => {
    expect(pathsOf({ name: 'SECRET-VALUE', inner: { n: 'SECRET-VALUE' } })).toEqual(['inner.n']);
  });

  it('WHEN the value is not an object THE SYSTEM SHALL report the root', () => {
    expect(pathsOf('SECRET-VALUE')).toEqual([ROOT_FIELD]);
  });

  it('WHEN the same path fails twice THE SYSTEM SHALL list it once', () => {
    expect(pathsOf({ inner: 1 })).toEqual(['name', 'inner']);
  });

  it('WHEN a key is unknown THE SYSTEM SHALL name it, nested under its parent', () => {
    expect(pathsOf({ name: 'a', inner: { n: 1, extra: 1 } })).toEqual(['inner.extra']);
  });
});

describe('publicFieldPaths', () => {
  const known = new Set(['name', 'inner', 'inner.n']);

  it('WHEN a path is one the API defines THE SYSTEM SHALL keep it', () => {
    expect(publicFieldPaths(['name', 'inner.n'], known)).toEqual(['name', 'inner.n']);
  });

  it('WHEN a path ends in a key the caller invented THE SYSTEM SHALL show the nearest known parent', () => {
    expect(publicFieldPaths(['inner.SECRET-KEY'], known)).toEqual(['inner']);
  });

  it('WHEN a top-level key is invented THE SYSTEM SHALL show the root', () => {
    expect(publicFieldPaths(['SECRET-KEY', 'name'], known)).toEqual([ROOT_FIELD, 'name']);
  });

  it('WHEN several invented keys share a parent THE SYSTEM SHALL list the parent once', () => {
    expect(publicFieldPaths(['inner.a', 'inner.b'], known)).toEqual(['inner']);
  });
});
