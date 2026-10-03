// Mechanical enforcement of CLAUDE.md N2 / §3 (the .auth/ validity + freshness gate).
// Runs as a PreToolUse hook on mcp__playwright__browser_* calls so the check
// happens every time, regardless of whether the model remembers to run it.
//
// Fails closed (hook-utils.cjs): Claude Code treats a hook that crashes as
// non-blocking and lets the tool call through, so every failure path here - an
// unexpected error included - ends in a JSON deny on stdout with exit 0. The
// wrapper command in .claude/settings.json covers this file failing to load.
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { runHook, PROJECT_DIR } = require('./hook-utils.cjs');

const SESSION_FILE = path.join(PROJECT_DIR, '.auth', 'session.json');
const INIT_SCRIPT_FILE = path.join(PROJECT_DIR, '.auth', 'session.init.js');
const SESSION_STATE_MODULE = path.join(PROJECT_DIR, 'session-state.js');
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour, per CLAUDE.md §3.3
const MAX_LISTED = 5;

// Calls that read nothing off a page, so a stale session can't mislead them -
// gating browser_close would only leave a browser open.
const UNGATED = /__browser_close$/;

/** The STATE object global setup inlines into session.init.js, or null if it isn't there. */
function readInitPayload() {
  const text = fs.readFileSync(INIT_SCRIPT_FILE, 'utf-8');
  const m = /const STATE = (\{[\s\S]*?\n\});/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Keys whose values differ between two flat key/value maps - names only, never values. */
function differingKeys(expected, actual) {
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  return [...keys].filter(k => (expected ?? {})[k] !== (actual ?? {})[k]);
}

function listed(names) {
  const shown = names.slice(0, MAX_LISTED).map(n => `\`${n}\``);
  return names.length > MAX_LISTED ? `${shown.join(', ')}, ...` : shown.join(', ');
}

/** True when a cookie domain or an origins[] entry covers `host`. */
function hostCovered(host, state) {
  const h = host.toLowerCase();
  const cookieMatch = c => {
    const d = String(c?.domain ?? '')
      .toLowerCase()
      .replace(/^\./, '');
    return d !== '' && (h === d || h.endsWith(`.${d}`));
  };
  const originMatch = o => {
    try {
      return new URL(o.origin).hostname.toLowerCase() === h;
    } catch {
      return false;
    }
  };
  return state.cookies.some(cookieMatch) || state.origins.some(originMatch);
}

function navigateHost(input) {
  if (!/__browser_navigate$/.test(input.tool_name ?? '')) return null;
  const url = input.tool_input && input.tool_input.url;
  if (typeof url !== 'string' || url === '') return null;
  for (const candidate of [url, `https://${url}`]) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
      return null; // about:, data:, file: ... - no session involved
    } catch {
      // Try again with a scheme.
    }
  }
  return null;
}

async function findProblems(input) {
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
  const { validateSessionState, findExpiredCookies, localStorageByOrigin } = await import(
    pathToFileURL(SESSION_STATE_MODULE).href
  );

  const problems = validateSessionState(state).map(e => `${e}.`);
  const shapeOk = problems.length === 0;

  // validateSessionState() treats sessionStorage as optional (readSessionState()
  // defaults it to {}); the gate requires it, since global setup always writes it.
  if (shapeOk && state.sessionStorage === undefined) {
    problems.push('`sessionStorage` field is missing.');
  }
  if (shapeOk) {
    for (const c of findExpiredCookies(state.cookies)) {
      problems.push(
        `cookie \`${c.name}\` is expired (expires=${c.expires}, ${new Date(c.expires * 1000).toISOString()}).`,
      );
    }
  }

  if (!fs.existsSync(INIT_SCRIPT_FILE)) {
    problems.push('.auth/session.init.js is missing.');
  } else if (shapeOk) {
    // Both files come from one capture, so they must agree; a mismatch means a
    // half-written or hand-edited pair.
    const payload = readInitPayload();
    if (payload === null) {
      problems.push('.auth/session.init.js is not in the format global setup writes.');
    } else {
      const sessionKeys = differingKeys(state.sessionStorage, payload.sessionStorage);
      if (sessionKeys.length > 0) {
        problems.push(
          `session.init.js and session.json disagree on sessionStorage ${listed(sessionKeys)}.`,
        );
      }
      const expected = localStorageByOrigin(state.origins);
      const origins = new Set([
        ...Object.keys(expected),
        ...Object.keys(payload.localStorage ?? {}),
      ]);
      for (const origin of origins) {
        const keys = differingKeys(expected[origin], (payload.localStorage ?? {})[origin]);
        if (keys.length > 0) {
          problems.push(
            `session.init.js and session.json disagree on localStorage ${listed(keys)} for ${origin}.`,
          );
        }
      }
    }
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

  const host = navigateHost(input);
  if (shapeOk && host !== null && !hostCovered(host, state)) {
    problems.push(
      `no cookie or origins[] entry in session.json covers ${host}, so the page would load ` +
        'logged out. Navigate to the app the session was captured for.',
    );
  }

  return problems;
}

runHook({
  name: 'check-session-gate',
  rule: '§3 (N2)',
  async main(input, { deny }) {
    // The matcher in .claude/settings.json routes only browser tools here; an
    // input without a tool name is gated anyway.
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
    if (toolName && !/^mcp__.+__browser_/.test(toolName)) return;
    if (UNGATED.test(toolName)) return;

    const problems = await findProblems(input);
    if (problems.length === 0) return;
    deny(
      `Blocked by CLAUDE.md §3 (N2): the .auth/ session gate failed:\n` +
        `${problems.map(p => `- ${p}`).join('\n')}\n\n` +
        'Ask the user to re-create the session by running `npm run test:debug` (or a ' +
        'test:parallel:* variant) - these wipe .auth/ and log in fresh. Never run it ' +
        'yourself (N1), and never hand-write or repair these files.',
      problems.join(' | '),
    );
  },
});
