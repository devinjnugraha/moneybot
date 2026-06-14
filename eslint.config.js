// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // NFR-02: no DB driver imports outside the Neon adapter
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pg', 'pg/*', '@neondatabase/serverless'],
              message:
                'DB drivers may only be imported inside src/adapters/neon/*.ts (NFR-02).',
              allowTypeImports: false,
            },
          ],
        },
      ],
    },
  },
  {
    // The adapter itself is allowed to import the driver
    files: ['src/adapters/neon/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
