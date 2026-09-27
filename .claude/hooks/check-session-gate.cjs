// Mechanical enforcement of CLAUDE.md N2 / §3 (the .auth/ validity + freshness gate).
// Runs as a PreToolUse hook on mcp__playwright__browser_* calls so the check
// happens every time, regardless of whether the model remembers to run it.
//
// Fails closed: Claude Code treats a hook that crashes (exit 1) as
// non-blocking and lets the tool call through, so every failure path here -
// an unexpected error included - ends in a JSON deny on stdout with exit 0.
// (Not exit 2: PowerShell, which runs hooks where Git Bash isn't installed,
// reports any failing native command as exit 1.)
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Resolved from this file's location (.claude/hooks/), not process.cwd(): hooks
// run in whatever directory the session is in when the tool call fires.
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const SESSION_FILE = path.join(PROJECT_DIR, '.auth', 'session.json');
const INIT_SCRIPT_FILE = path.join(PROJECT_DIR, '.auth', 'session.init.js');
const SESSION_STATE_MODULE = path.join(PROJECT_DIR, 'session-state.js');
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour, per CLAUDE.md §3.3

let responded = false;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function deny(reasons) {
  if (responded) return;
  responded = true;
  const reason = reasons.map(r => `- ${r}`).join('\n');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked by CLAUDE.md §3 (N2): the .auth/ session gate failed:\n${reason}\n\n` +
          'Ask the user to re-create the session by running `npm run test:debug` (or a ' +
          'test:parallel:* variant) - these wipe .auth/ and log in fresh. Never run it ' +
          'yourself (N1), and never hand-write or repair these files.',
      },
    }),
  );
}

// Last resort for anything that escapes main()'s own error handling.
process.on('uncaughtException', err => {
  deny([`the gate crashed: ${err && err.message ? err.message : err}`]);
});

async function findProblems() {
  if (!fs.existsSync(SESSION_FILE)) {
    return ['.auth/session.json is missing.'];
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch (err) {
    return [`.auth/session.json is not valid JSON: ${err.message}`];
  }

  // The same shape and expiry rules readSessionState() applies in a real run,
  // so the gate can never pass a file the test step would reject.
  const { validateSessionState, findExpiredCookies } = await import(
    pathToFileURL(SESSION_STATE_MODULE).href
  );

  const problems = validateSessionState(state).map(e => `${e}.`);
  const isObject = state !== null && typeof state === 'object' && !Array.isArray(state);

  // validateSessionState() treats sessionStorage as optional (readSessionState()
  // defaults it to {}); the gate requires it, since global setup always writes it.
  if (isObject && state.sessionStorage === undefined) {
    problems.push('`sessionStorage` field is missing.');
  }
  if (isObject && Array.isArray(state.cookies)) {
    for (const c of findExpiredCookies(state.cookies)) {
      problems.push(
        `cookie \`${c.name}\` is expired (expires=${c.expires}, ${new Date(c.expires * 1000).toISOString()}).`,
      );
    }
  }
  if (!fs.existsSync(INIT_SCRIPT_FILE)) {
    problems.push('.auth/session.init.js is missing.');
  }

  for (const file of [SESSION_FILE, INIT_SCRIPT_FILE]) {
    if (!fs.existsSync(file)) continue; // already reported above
    const ageMs = Date.now() - fs.statSync(file).mtimeMs;
    if (ageMs > MAX_AGE_MS) {
      problems.push(
        `${path.basename(file)} is ${(ageMs / 3.6e6).toFixed(2)}h old (must be <= 1h).`,
      );
    }
  }

  return problems;
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}') ?? {};
  } catch {
    // Unreadable hook input says nothing about the session. The matcher in
    // .claude/settings.json only routes browser tools here, so gate anyway.
  }

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (toolName && !/^mcp__playwright__browser_/.test(toolName)) {
    return; // not a browser call - allow
  }

  const problems = await findProblems();
  if (problems.length > 0) {
    deny(problems);
  }
}

main().catch(err => {
  deny([`the gate could not complete its checks: ${err && err.message ? err.message : err}`]);
});
