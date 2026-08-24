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
    // The administrator bundle (M08.7). Same React rules as the player client,
    // plus the import boundary ADR 0023 §1 draws around it: an admin screen
    // talks to the orchestration process over the contract and never reaches
    // into the process itself, into the simulator it drives, or into the player
    // application beside it. `apps/admin-client/src/boundary.test.ts` reads the
    // sources for the same properties; the lint rule is what says so while
    // somebody is typing the import.
    files: ['apps/admin-client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@tcg/admin-server',
                '@tcg/simulator',
                '@tcg/rules-engine',
                '@tcg/web-client',
                '@tcg/multiplayer-server',
                'node:*',
              ],
              message:
                'The admin client speaks to the orchestration process through @tcg/admin-contracts, and runs in a browser (ADR 0023 §1).',
            },
          ],
        },
      ],
    },
  },
  {
    // The boundary suite proves those absences by reading the repository's own
    // files, which takes `node:fs`. Restricting the shipped sources and exempting
    // the test that checks them is the same shape `packages/admin-contracts` and
    // `apps/admin-server` already use.
    files: ['apps/admin-client/**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
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
