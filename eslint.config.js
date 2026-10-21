import js from '@eslint/js';
import globals from 'globals';

export default [
  // Same generated paths as .gitignore / .prettierignore (CLAUDE.md §1).
  {
    ignores: [
      'node_modules/',
      '.features-gen/',
      'test-results/',
      'playwright-report/',
      'blob-report/',
      '.auth/',
      '.playwright-mcp/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // The hooks are CommonJS, run directly by node.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // Functions passed to page.evaluate() / addInitScript() run in the browser.
    files: ['steps/**/*.js', 'global-setup.js', 'session-state.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    // `const { Given, When, Then } = createBdd();` is the house pattern (CLAUDE.md §4),
    // so a step file that doesn't use all three is expected - flag it, don't fail.
    files: ['steps/**/*.js'],
    rules: { 'no-unused-vars': ['warn', { args: 'none' }] },
  },
];
