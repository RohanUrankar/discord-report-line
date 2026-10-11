// @ts-check
import js from '@eslint/js';
import angular from 'angular-eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// apps/web: Angular 21 dashboard. Template accessibility rules are errors (WCAG 2.2 AA is a requirement,
// not a nicety), and the browser-security rules from the frontend-guidelines skill are lint rules too.
export default tseslint.config(
  { ignores: ['dist/**', '.angular/**', 'coverage/**', 'out-tsc/**'] },
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
      '@angular-eslint/prefer-inject': 'error',
      '@angular-eslint/prefer-standalone': 'error',
      '@angular-eslint/no-input-rename': 'error',
      '@typescript-eslint/consistent-type-imports': 'off', // Angular DI needs runtime class imports
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],
      '@typescript-eslint/unbound-method': ['error', { ignoreStatic: true }], // Validators.required
      eqeqeq: 'error',
      curly: ['error', 'all'],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use an `as const` tuple and a derived union.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'localStorage',
          message:
            'Nothing is stored in the browser (no tokens, no secrets). Raise a proposal if you need it.',
        },
        {
          object: 'sessionStorage',
          message:
            'Nothing is stored in the browser (no tokens, no secrets). Raise a proposal if you need it.',
        },
        { property: 'bypassSecurityTrustHtml', message: 'Render server text as text.' },
        { property: 'bypassSecurityTrustUrl', message: 'Render server text as text.' },
        { property: 'bypassSecurityTrustScript', message: 'Render server text as text.' },
        { property: 'bypassSecurityTrustStyle', message: 'Render server text as text.' },
        { property: 'bypassSecurityTrustResourceUrl', message: 'Render server text as text.' },
        { property: 'innerHTML', message: 'Never write HTML from code; use interpolation.' },
        { property: 'outerHTML', message: 'Never write HTML from code; use interpolation.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Only core/api talks to the network, through HttpClient.' },
        {
          name: 'XMLHttpRequest',
          message: 'Only core/api talks to the network, through HttpClient.',
        },
      ],
    },
  },
  {
    // Only the API client may use HttpClient (frontend-guidelines: "only core/api talks to HttpClient").
    files: ['src/app/**/*.ts'],
    ignores: ['src/app/core/api/**', 'src/app/core/http/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@angular/common/http',
              importNames: ['HttpClient'],
              message: 'Go through ApiClient (core/api).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', 'src/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/no-inline-styles': 'off',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
