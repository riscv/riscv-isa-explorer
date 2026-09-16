const js = require('@eslint/js');
const react = require('eslint-plugin-react');
const globals = require('globals');

/**
 * Flat config (ESLint 9).
 *
 * Pinned to 9 rather than 10 because eslint-plugin-react does not support 10
 * yet, and losing the React rules on a React codebase is the worse trade.
 *
 * ecmaVersion is 'latest' rather than a pinned year: src/isaGraph.js uses
 * import attributes (`with { type: 'json' }`), and a fixed 2023 parser reports
 * that valid syntax as a parse error, taking the whole file out of linting.
 *
 * The intent is a ratchet, not a rewrite. Rules are set where the code already
 * passes, so `npm run lint` is green today and a future failure means a real
 * regression rather than inherited debt.
 */
module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  // Browser code.
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.flat.recommended.rules,

      // The build uses @babel/preset-react with `runtime: 'classic'`, set
      // explicitly because Babel 8 defaults to automatic. JSX compiles to
      // React.createElement, so every .jsx file needs React in scope even when
      // it never writes `React.`.
      // These were previously off — the automatic-runtime setting — which made
      // eslint report a required import as unused. Someone deleted one on that
      // advice and the page crashed the moment that component mounted, with
      // lint and build both green. Leave these on unless the loader switches to
      // `runtime: 'automatic'`.
      'react/react-in-jsx-scope': 'error',
      'react/jsx-uses-react': 'error',

      // The catalogue is data-driven and props are passed through in bulk, so
      // prop-types here would be noise rather than safety.
      'react/prop-types': 'off',

      // Copy contains reviewed apostrophes and quotes.
      'react/no-unescaped-entities': 'off',

      // Catches the defect that actually bit this project: a component declared
      // inside another is a new type every render, remounting its whole subtree.
      'react/no-unstable-nested-components': 'error',

      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Node scripts and tests.
  {
    files: ['scripts/**/*.{js,mjs,cjs}', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // CommonJS config files at the repo root.
  {
    files: ['*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules },
  },
];
