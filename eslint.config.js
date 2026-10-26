// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.cache/**',
      '**/coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Règle d'or : le cœur métier doit tourner tel quel sur Android et desktop.
    // Toute I/O passe par des interfaces injectées.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'packages/core ne doit importer aucun module Node.' }] },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Injectez un client HTTP au lieu du fetch global.' },
        { name: 'window', message: 'packages/core ne dépend pas du navigateur.' },
        { name: 'document', message: 'packages/core ne dépend pas du navigateur.' },
        { name: 'process', message: 'Configuration injectée, pas de process.env.' },
      ],
    },
  },
  {
    // En test, `tableau[i]!` après une assertion de longueur est plus lisible qu'une garde.
    files: ['**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
