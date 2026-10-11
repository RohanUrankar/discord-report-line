// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// DESIGN §7 (rev 3): packages/shared is a leaf. It is bundled into the Angular dashboard, so it must never
// pull in backend code, Node built-ins or anything that does I/O. Its only dependency is zod.
export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: 'error',
      curly: ['error', 'all'],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use an `as const` tuple and a derived union.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'pg', 'pg-*', 'express', 'express-*'],
              message: 'packages/shared is a leaf: no Node built-ins or I/O (DESIGN §7).',
            },
            {
              group: ['@report-line/api', '**/apps/*', '../../*'],
              message: 'packages/shared must never import from apps/* (DESIGN §7 package graph).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'No network in packages/shared.' },
        { name: 'process', message: 'No environment access in packages/shared.' },
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
