import { safeReturnUrl } from './safe-return-url';

describe('safeReturnUrl', () => {
  it.each([
    '/',
    '/g/111111111111111111/log',
    '/g/111111111111111111/log?filter=attention',
    '/connect#x',
  ])('keeps the in-app path %s', (path) => {
    expect(safeReturnUrl(path)).toBe(path);
  });

  it.each([
    ['a full URL', 'https://evil.example/phish'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash host trick', '/\\evil.example'],
    ['a backslash after a slash', '/\\/evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a scheme without slashes', 'http:evil.example'],
    ['a relative path', 'g/1/log'],
    ['whitespace in the path', '/g/1 /log'],
    ['a newline', '/g/1\n/log'],
    ['a control character', '/g/\u0000'],
    ['the login page itself', '/login'],
    ['the login page with a query', '/login?returnUrl=%2F'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
  ])('WHEN the return URL is %s THE UI SHALL ignore it', (_name, candidate) => {
    expect(safeReturnUrl(candidate)).toBeNull();
  });

  it('refuses an absurdly long value', () => {
    expect(safeReturnUrl(`/${'a'.repeat(3000)}`)).toBeNull();
  });
});
