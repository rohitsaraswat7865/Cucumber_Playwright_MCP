// Shared plumbing for the PreToolUse hooks in this folder: reading the hook
// input, answering deny/ask, the audit log, failing closed, and the path rules
// shared by the file-tool guard (check-generated-files.cjs) and the shell-write
// guard (check-shell-writes.cjs), so the two can't drift apart.
'use strict';

const fs = require('fs');
const path = require('path');

// Resolved from this file's location (.claude/hooks/), not process.cwd(): hooks
// run in whatever directory the session is in when the tool call fires.
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const LOG_FILE = path.join(__dirname, 'hook.log');
const LOG_MAX_BYTES = 1024 * 1024;

// Top-level or nested directories / files marked ❌ generated in CLAUDE.md §1 ->
// what rewrites them. Keep in step with CLAUDE.md §1, .gitignore and .prettierignore.
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
const HOOK_LOG = '.claude/hooks/hook.log';

// The harness itself (CLAUDE.md §1 ⚠️ rows, plus what the §3 gate imports):
// editable, but only when the user explicitly asks, so changes need their OK.
const PROTECTED = [
  ['.claude/settings.json', 'it wires up the hooks that enforce CLAUDE.md'],
  ['.claude/settings.local.json', "it is the user's personal permission allow list"],
  ['.claude/hooks', 'it is the hook code that enforces CLAUDE.md'],
  ['session-state.js', 'the §3 session gate imports its validation rules'],
  ['.mcp.json', 'it configures the Playwright MCP server (§7)'],
];

const sameName = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * `target` as a project-relative path with forward slashes, or null when it
 * lies outside the project. Git Bash paths (/c/Users/...) are understood too.
 */
function relToProject(target, cwd) {
  if (typeof target !== 'string' || target === '') return null;
  let t = target;
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(t))
    t = `${t[1]}:${t.slice(2) || '/'}`;
  const base = typeof cwd === 'string' && cwd ? cwd : PROJECT_DIR;
  const rel = path.relative(PROJECT_DIR, path.resolve(base, t));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * What a project-relative path is to the harness:
 *   { kind: 'generated', why } - never hand-edit (CLAUDE.md N4)
 *   { kind: 'protected', why } - harness config, change only when asked
 *   null                       - an ordinary file
 */
function classifyPath(rel) {
  if (typeof rel !== 'string' || rel === '') return null;
  if (sameName(rel, HOOK_LOG) || sameName(rel, `${HOOK_LOG}.1`)) {
    return { kind: 'generated', why: 'The hooks append to it' };
  }
  // Any segment, so nested copies (e.g. foo/.features-gen/x) are caught too.
  for (const segment of rel.split('/')) {
    const name = Object.keys(GENERATED).find(g => sameName(g, segment));
    if (name) return { kind: 'generated', why: GENERATED[name] };
  }
  for (const [p, why] of PROTECTED) {
    if (sameName(rel, p) || sameName(rel.slice(0, p.length + 1), `${p}/`)) {
      return { kind: 'protected', why };
    }
  }
  return null;
}

/** Appends one line to the gitignored audit log. Never throws, never logs secrets. */
function audit(entry) {
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(
      LOG_FILE,
      `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Logging is best-effort; a read-only checkout must not break the guard.
  }
}

/**
 * Runs a hook's `main(input, { deny, ask })` and fails closed: an unreadable
 * input or any error - sync, async or uncaught - ends in a JSON deny on stdout
 * with exit 0. (Claude Code treats a crashing hook as non-blocking, and not
 * exit 2: PowerShell, which runs hooks where Git Bash isn't installed, reports
 * any failing native command as exit 1.)
 *
 * `detail` is what goes to the audit log - keep tokens and cookie values out.
 */
function runHook({ name, rule, main }) {
  let responded = false;
  let tool = '';

  const respond = (decision, reason, detail) => {
    if (responded) return;
    responded = true;
    audit({ hook: name, tool, rule, decision, detail: detail ?? reason });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      }),
    );
  };

  const failClosed = err => {
    const message = err && err.message ? err.message : String(err);
    respond(
      'deny',
      `Blocked by CLAUDE.md ${rule}: the ${name} hook failed, so the call is blocked rather ` +
        `than let through unchecked (${message}). Tell the user - the hook needs fixing.`,
      `hook error: ${message}`,
    );
  };

  process.on('uncaughtException', failClosed);

  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  } catch (err) {
    failClosed(new Error(`unreadable hook input: ${err.message}`));
    return;
  }
  if (input === null || typeof input !== 'object') {
    failClosed(new Error('hook input is not a JSON object'));
    return;
  }
  tool = typeof input.tool_name === 'string' ? input.tool_name : '';

  Promise.resolve()
    .then(() =>
      main(input, {
        deny: (reason, detail) => respond('deny', reason, detail),
        ask: (reason, detail) => respond('ask', reason, detail),
      }),
    )
    .catch(failClosed);
}

module.exports = { PROJECT_DIR, GENERATED, PROTECTED, relToProject, classifyPath, audit, runHook };
