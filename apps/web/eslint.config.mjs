import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * ESLint flat config. `next/core-web-vitals` + `next/typescript` with two project rules:
 *  - no raw hex colors / hardcoded UI strings in components (see overrides below via
 *    `no-restricted-syntax` on literal className hex + non-i18n string JSX text is a
 *    review rule, enforced by the trust-renderer prop types rather than the linter).
 */
export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript', 'plugin:jsx-a11y/recommended'),
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'public/**', 'src/lib/mock/fixtures/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'react/no-unescaped-entities': 'off',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['src/**/*.tsx'],
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
];
