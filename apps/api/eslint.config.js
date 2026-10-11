// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const IO_MODULES = ['express', 'pg', 'pg-*', 'undici', 'node-fetch', 'axios', 'pino'];

/**
 * Import bans that turn domain/'s allow-list into lint errors (DESIGN §7). Each pattern has its own
 * message so a failure says which rule was broken.
 * @param {{ allowNodeCrypto: boolean }} options
 */
function domainImportBans({ allowNodeCrypto }) {
  return [
    {
      regex: '(^|/)\\.\\.(/|$)',
      message: 'domain/ imports nothing outside domain/ (DESIGN §7).',
    },
    {
      regex: '^@report-line/shared/',
      message: 'Import @report-line/shared from its root, not its internals.',
    },
    ...(allowNodeCrypto
      ? []
      : [
          {
            regex: '^node:crypto$',
            message: 'node:crypto is allowed only in domain/signature.ts.',
          },
        ]),
    {
      regex: '^(?!\\./|@report-line/shared($|/)|zod$|node:crypto$)',
      message: 'domain/ may import only ./*, @report-line/shared and zod (DESIGN §7).',
    },
  ];
}

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' },
      ],
      eqeqeq: 'error',
      curly: ['error', 'all'],
      'max-depth': ['error', 3],
      'no-else-return': 'error',
      'no-console': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use an `as const` object and a derived union.' },
      ],
    },
  },
  {
    // DESIGN §7 (rev 3 + proposal 0004): domain/ is pure. Strict import allow-list: relative imports
    // within domain/, @report-line/shared (root only) and zod; node:crypto only in signature.ts.
    files: ['src/domain/**/*.ts'],
    ignores: ['src/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: domainImportBans({ allowNodeCrypto: false }) },
      ],
    },
  },
  {
    files: ['src/domain/signature.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: domainImportBans({ allowNodeCrypto: true }) }],
    },
  },
  {
    // Domain tests may also use vitest and node:crypto (self-generated signing keys), never I/O.
    files: ['src/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: IO_MODULES, message: 'Domain tests must stay free of I/O.' }],
        },
      ],
    },
  },
  {
    // Global bans for all of domain/, tests included: no network, env, ambient clock or randomness.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'No network in domain/.' },
        { name: 'process', message: 'Config is read in config.ts only.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Inject `rnd` instead (deterministic tests).',
        },
        { object: 'Date', property: 'now', message: 'Inject the current time instead.' },
      ],
      'no-param-reassign': ['error', { props: true }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
