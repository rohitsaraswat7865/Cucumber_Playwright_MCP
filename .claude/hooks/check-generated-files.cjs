// Mechanical enforcement of CLAUDE.md N4 / §1 (never hand-edit a generated file).
// Runs as a PreToolUse hook on Claude's file-editing tools and denies writes to
// the paths marked ❌ generated in CLAUDE.md §1: they're rewritten by global
// setup, bddgen, the test run, the MCP server or npm, so a hand-edit is either
// silently discarded or - for .auth/ - silently breaks the session.
//
// Covers Claude's file tools only; shell writes aren't inspected. Fails open:
// if this script itself breaks, the edit goes through as it did before the
// hook existed, rather than blocking every edit.
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Top-level paths marked ❌ generated in CLAUDE.md §1 -> what rewrites them.
const GENERATED = {
  '.auth':
    'Global setup rewrites it on every run - to refresh it, ask the user to run `npm run test:debug`',
  '.features-gen':
    'bddgen regenerates it from features/ on every run - edit the .feature file or steps/ instead',
  'test-results': 'The test run writes it',
  'playwright-report': 'The test run writes it',
  'blob-report': 'The test run writes it',
  '.playwright-mcp': 'The Playwright MCP server writes it',
  node_modules: 'npm installs it - change package.json instead',
  'package-lock.json': 'npm rewrites it - change package.json and run `npm install` instead',
};

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  } catch {
    return; // no usable input - allow
  }
  if (!input || !EDIT_TOOLS.has(input.tool_name)) return;

  const toolInput = input.tool_input || {};
  const target = toolInput.file_path || toolInput.notebook_path;
  if (typeof target !== 'string' || target === '') return;

  const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : PROJECT_DIR;
  const rel = path.relative(PROJECT_DIR, path.resolve(base, target));
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (rel === '' || outside) return;

  const top = rel.split(/[\\/]/)[0];
  const sameName = (a, b) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const dir = Object.keys(GENERATED).find(d => sameName(d, top));
  if (!dir) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked by CLAUDE.md §1 (N4): ${rel.split(path.sep).join('/')} is generated output - ` +
          `never hand-edit it. ${GENERATED[dir]}.`,
      },
    }),
  );
}

try {
  main();
} catch (err) {
  // Fail open (see header), but loudly enough that a broken guard gets noticed.
  process.stderr.write(`check-generated-files hook failed, edit allowed: ${err && err.message}\n`);
  process.exitCode = 1;
}
