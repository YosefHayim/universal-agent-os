// Flat ESLint config — minimal, focused on no-explicit-any enforcement.
// Why flat config: eslint v9+ default; avoids legacy .eslintrc chains.
// Why defineConfig: typescript-eslint's `tseslint.config()` helper is
// deprecated in v8.x (see typescript-eslint.io/packages/typescript-eslint/#config-deprecated).
// ESLint core now ships the same merging/typing via `defineConfig()`.
// Scope: src, tests, scripts (TypeScript only). The build output (dist/),
// node_modules, and the husky shim folder are ignored.
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    ignores: ['dist/**', 'node_modules/**', '.husky/_/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx', 'scripts/**/*.ts', 'scripts/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
])
