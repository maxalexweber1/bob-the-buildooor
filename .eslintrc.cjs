/* Strict lint baseline. See CLAUDE.md §6 — do not relax to make code pass. */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, webextensions: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  settings: { react: { version: '18' } },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // Guardrail against the §1 "never log secrets" rule slipping in.
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.config.ts', 'vite.config.ts'],
};
