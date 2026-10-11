// @ts-check
import js from '@eslint/js';
import { importX } from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import security from 'eslint-plugin-security';
import globals from 'globals';
import path from 'node:path';
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
      // Relative specifiers pass here; local/domain-imports-stay-inside judges where they resolve.
      regex: '^(?!\\.{1,2}/|@report-line/shared($|/)|zod$|node:crypto$)',
      message: 'domain/ may import only domain/, @report-line/shared and zod (DESIGN §7).',
    },
  ];
}

const DOMAIN_DIR = path.resolve(import.meta.dirname, 'src/domain');

/**
 * Relative imports in domain/ must resolve inside src/domain/. A `..` is fine when it stays inside
 * (src/domain/a/b.ts importing ../c.js); it is an error only when the resolved path leaves domain/.
 * @type {import('eslint').Rule.RuleModule}
 */
const domainImportsStayInside = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { outside: 'domain/ imports nothing outside domain/ (DESIGN §7).' },
  },
  create(context) {
    /** @param {{ source?: { type: string; value?: unknown } | null }} node */
    const check = (node) => {
      const source = node.source;
      if (source?.type !== 'Literal' || typeof source.value !== 'string') {
        return;
      }
      if (!source.value.startsWith('.')) {
        return; // bare specifiers are the allow-list's job
      }
      const resolved = path.resolve(path.dirname(context.filename), source.value);
      const relative = path.relative(DOMAIN_DIR, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        context.report({ node: /** @type {any} */ (source), messageId: 'outside' });
      }
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  security.configs.recommended,
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
    // Import hygiene. Resolution is tsc's job (NodeNext), so `no-unresolved` is left off; these rules catch
    // what tsc cannot: cycles between layers, undeclared dependencies, duplicate and misplaced imports.
    plugins: { 'import-x': importX },
    rules: {
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          // Test tooling and the lint config itself may use devDependencies; shipped code may not.
          devDependencies: ['**/*.test.ts', 'test/**', 'vitest.config.ts', 'eslint.config.js'],
          // Shared tooling (vitest, typescript, eslint) is declared once in the workspace root.
          packageDir: [import.meta.dirname, path.resolve(import.meta.dirname, '../..')],
        },
      ],
    },
  },
  {
    // Node safety. `no-process-env` makes config.ts the only reader of the environment (backend-guidelines);
    // `no-sync` keeps blocking calls out of request and worker paths.
    plugins: { n: nodePlugin },
    rules: {
      'n/no-process-env': 'error',
      'n/no-sync': 'error',
      'n/prefer-node-protocol': 'error',
    },
  },
  {
    // Config, the process entry point and test tooling are where the environment is legitimately read.
    files: [
      'src/config.ts',
      'src/index.ts',
      'test/**/*.ts',
      'vitest.config.ts',
      'src/**/*.test.ts',
    ],
    rules: { 'n/no-process-env': 'off' },
  },
  {
    files: ['vitest.config.ts', 'test/**/*.ts', 'src/**/*.test.ts'],
    rules: { 'n/no-sync': 'off', 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    // `detect-object-injection` flags every `obj[key]`, which the types already constrain; with
    // `noUncheckedIndexedAccess` on it is noise that hides the security rules that matter here.
    rules: { 'security/detect-object-injection': 'off' },
  },
  {
    // DESIGN §7: app/ orchestrates ports. It never imports I/O libraries or the layers that wire it.
    files: ['src/app/**/*.ts'],
    ignores: ['src/app/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: IO_MODULES, message: 'app/ depends on ports/, never on I/O libraries.' },
            { regex: '(^|/)(adapters|http)/', message: 'app/ must not import adapters/ or http/.' },
          ],
        },
      ],
    },
  },
  {
    // DESIGN §7 (rev 3 + proposal 0004): domain/ is pure. Strict import allow-list: relative imports
    // resolving inside domain/, @report-line/shared (root only) and zod; node:crypto only in signature.ts.
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
    files: ['src/domain/**/*.ts'],
    plugins: { local: { rules: { 'domain-imports-stay-inside': domainImportsStayInside } } },
    rules: { 'local/domain-imports-stay-inside': 'error' },
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
