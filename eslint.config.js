import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web-client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // The bot configuration contract describes a bot seat and nothing more: it
    // must not reach the engine, the UI, or the pilots that read it, so a client
    // validating a bot seat view never drags a decision procedure in with it
    // (ADR 0024 §7). The dependency runs bot-interface -> bot-config.
    files: ['packages/bot-config/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                '@tcg/web-client',
                '@tcg/rules-engine',
                '@tcg/bot-interface',
                '@tcg/protocol',
              ],
              message:
                'The bot configuration contract must not depend on the UI, server, engine or pilots (ADR 0024).',
            },
          ],
        },
      ],
    },
  },
  {
    // Card/deck data packages must never reach into UI, server or engine code.
    files: ['packages/card-data/**/*.ts', 'packages/deck/**/*.ts', 'packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', '@tcg/web-client', '@tcg/rules-engine'],
              message:
                'Data packages must not depend on the UI, server, simulator or rules engine (see CLAUDE.md §3).',
            },
          ],
        },
      ],
    },
  },
);
