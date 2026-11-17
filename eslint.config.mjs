// Obsidian's official review rules: eslint-plugin-obsidianmd's recommended config at its own severities, with the
// scanner's security rules as errors and the rules the scanner switches off kept off (obsidianmd/obsidian-workflows
// src/lint.ts). npm run lint runs with --max-warnings 0, so every warning fails. No build step: main.js is the
// source and the shipped file, so it is what gets linted.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js'; // internal path: re-check when the plugin version changes

const NAMES = ['LifeWorld Capture', 'LifeWorld'];
// Not whole sentences, or names the rule would lowercase: the built-in destinations (Daily Note), the Due property,
// key symbols, clock times and property examples.
const NOT_SENTENCES = ['^\\d', '⌘', '^\\+ ', '\\bDaily Note\\b', '\\bDue property\\b', '\\b(HH:MM|AM|PM)\\b', '^[a-z_]+: ', 'Tasks plugin', '\\b(Today|Planner)\\b'];
const SECURITY = ['no-eval', 'no-implied-eval', 'no-unsanitized/method', 'no-unsanitized/property', 'obsidianmd/regex-lookbehind', 'obsidianmd/no-forbidden-elements'];
const OFF = ['no-undef', '@typescript-eslint/restrict-template-expressions', '@typescript-eslint/no-base-to-string', 'import/no-unresolved'];

export default defineConfig([
  { files: ['main.js'], languageOptions: { sourceType: 'commonjs', parserOptions: { project: './tsconfig.lint.json' } } },
  ...obsidianmd.configs.recommended,
  {
    files: ['main.js'],
    rules: { ...Object.fromEntries(SECURITY.map((r) => [r, 'error'])), ...Object.fromEntries(OFF.map((r) => [r, 'off'])), 'eslint-comments/require-description': 'error',
      'obsidianmd/ui/sentence-case': ['warn', { brands: [...DEFAULT_BRANDS, ...NAMES], ignoreRegex: NOT_SENTENCES }] },
  },
]);
