import fs from 'node:fs';
import path from 'node:path';

export const SESSION_FILE = path.resolve('.auth/session.json');

// Single source of truth for the on-disk shape of .auth/session.json.
//
// Required shape - Playwright's native storageState format, plus one extra
// top-level `sessionStorage` field:
//
//   {
//     "cookies": [ { name, value, domain, path, ... } ],
//     "origins": [ { "origin": "https://example.com",
//                    "localStorage": [ { "name": "k", "value": "v" } ] } ],
//     "sessionStorage": { "k": "v" }
//   }
//
// The native part is non-negotiable, because two consumers read this file and
// only one of them is our code:
//
//   1. `npx playwright test` - the "I inject session state from file" step
//      replays cookies + localStorage + sessionStorage into each scenario's
//      context.
//   2. The Playwright MCP server - `--storage-state=.auth/session.json` in
//      .mcp.json is passed straight to browser.newContext({ storageState }).
//      Playwright reads only `cookies` and `origins`, and silently ignores
//      every other key. A hand-rolled shape such as
//      { origin: "...", localStorage: {} } therefore restores nothing at all
//      and raises no error - the browser just comes up logged out.
//
// `sessionStorage` is ignored by Playwright too (storageState has no field for
// it - the auth docs state outright that "Playwright does not provide API to
// persist session storage"), which is why it lives outside the native
// structure. Both consumers therefore replay web storage themselves: the test
// step via page.addInitScript(), and the MCP server via the generated
// .auth/session.init.js loaded with --init-script. Extra top-level keys are
// harmless to Playwright, so one file stays usable by both.

/** Returns a list of human-readable problems; empty means the state is usable. */
export function validateSessionState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return ['the file does not contain a JSON object'];
  }

  const errors = [];

  if (!Array.isArray(state.cookies)) {
    errors.push('`cookies` is missing or is not an array');
  }

  if (!Array.isArray(state.origins)) {
    // The common hand-edited mistake: singular `origin` with a top-level
    // localStorage map. Playwright ignores both, so call it out by name.
    const handEdited = 'origin' in state || 'localStorage' in state;
    errors.push(
      handEdited
        ? '`origins` array is missing (found singular `origin` / top-level `localStorage`, which Playwright ignores)'
        : '`origins` is missing or is not an array',
    );
  } else {
    state.origins.forEach((entry, i) => {
      if (typeof entry?.origin !== 'string') {
        errors.push(`origins[${i}].origin is missing or is not a string`);
      }
      if (entry?.localStorage !== undefined && !Array.isArray(entry.localStorage)) {
        errors.push(
          `origins[${i}].localStorage must be an array of { name, value } pairs, not an object`,
        );
      }
    });
  }

  if (
    state.sessionStorage !== undefined &&
    (state.sessionStorage === null ||
      typeof state.sessionStorage !== 'object' ||
      Array.isArray(state.sessionStorage))
  ) {
    errors.push('`sessionStorage` must be an object of key/value pairs');
  }

  return errors;
}

function formatErrors(errors) {
  return errors.map(e => `  - ${e}`).join('\n');
}

/**
 * Returns cookies whose `expires` timestamp (unix seconds) is already in the
 * past. `-1` means a session cookie with no persistent expiry, so it is never
 * considered expired here.
 *
 * This only catches the client-side half of "expired": a cookie whose own
 * expiry has lapsed. It cannot detect the server invalidating a still-live
 * cookie (session revoked, token rotated, etc.) - that failure only shows up
 * by actually navigating and checking for signed-in UI (see CLAUDE.md §4).
 */
export function findExpiredCookies(cookies, now = Date.now() / 1000) {
  return cookies.filter(c => typeof c.expires === 'number' && c.expires !== -1 && c.expires < now);
}

/**
 * Reads and validates the session file. Throws loudly rather than returning a
 * half-empty state, so a malformed file can never masquerade as a logged-in
 * session.
 */
export function readSessionState() {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(
      `Session state file not found: ${SESSION_FILE}\n` +
        'Run `npm run test:debug` to log in and create it before running scenarios that inject session state.',
    );
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch (cause) {
    throw new Error(`Session state file is not valid JSON: ${SESSION_FILE}\n  - ${cause.message}`);
  }

  const errors = validateSessionState(state);
  if (errors.length > 0) {
    throw new Error(
      `Session state file is not in Playwright's native storageState format: ${SESSION_FILE}\n` +
        `${formatErrors(errors)}\n` +
        'Re-login by running `npm run test:debug` to regenerate it. Never hand-edit it: the ' +
        'Playwright MCP server reads the same file via --storage-state and silently ignores ' +
        'any non-native shape, which produces a logged-out browser with no error.',
    );
  }

  const expired = findExpiredCookies(state.cookies);
  if (expired.length > 0) {
    throw new Error(
      `Session state file has expired cookies: ${SESSION_FILE}\n` +
        `${formatErrors(expired.map(c => `\`${c.name}\` expired at ${new Date(c.expires * 1000).toISOString()}`))}\n` +
        'Session expired - re-login by running `npm run test:debug`, which wipes .auth/ and logs in fresh.',
    );
  }

  return {
    cookies: state.cookies,
    origins: state.origins,
    sessionStorage: state.sessionStorage ?? {},
  };
}

/** True only if the file on disk exists and is usable as-is. */
export function hasUsableSessionState() {
  try {
    readSessionState();
    return true;
  } catch {
    return false;
  }
}

/**
 * Captures `context` in native storageState format, appends `sessionStorage`,
 * and writes the result to SESSION_FILE. Validates before returning so a bad
 * write fails at setup time rather than in a scenario.
 */
export async function writeSessionState(context, sessionStorage = {}) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });

  const storageState = await context.storageState();
  const state = { ...storageState, sessionStorage };

  const errors = validateSessionState(state);
  if (errors.length > 0) {
    throw new Error(`Refusing to write malformed session state:\n${formatErrors(errors)}`);
  }

  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
  return state;
}

/** `origins[]` flattened to { "https://host": { key: value } } for injection. */
export function localStorageByOrigin(origins) {
  return Object.fromEntries(
    origins.map(entry => [
      entry.origin,
      Object.fromEntries((entry.localStorage ?? []).map(({ name, value }) => [name, value])),
    ]),
  );
}

export const INIT_SCRIPT_FILE = path.resolve('.auth/session.init.js');

/**
 * Writes the MCP init script: the half of the session state that
 * `--storage-state` cannot carry.
 *
 * The Playwright MCP server has no tool for restoring web storage
 * (`--caps` accepts only vision/pdf/devtools as of v0.0.79 - there is no
 * `storage` capability and no browser_sessionstorage_* tools). What it does
 * have is `--init-script <path>`, documented as "evaluated in every page
 * before any of the page's scripts" - i.e. the CLI equivalent of
 * page.addInitScript(), which is exactly the workaround the Playwright auth
 * docs prescribe for sessionStorage.
 *
 * So global setup emits a script with the captured values inlined, and
 * .mcp.json loads it. localStorage is included too: harmless duplication of
 * what --storage-state already restores, and it keeps this file the single
 * mechanism for web storage rather than splitting it across two.
 *
 * Regenerated on every capture - never hand-edit it.
 */
export function writeInitScript(state) {
  const payload = {
    localStorage: localStorageByOrigin(state.origins ?? []),
    sessionStorage: state.sessionStorage ?? {},
  };

  const script = `// GENERATED by global-setup.js - do not edit.
// Loaded by the Playwright MCP server via --init-script (see .mcp.json).
// Restores localStorage + sessionStorage, which --storage-state cannot carry.
(() => {
  const STATE = ${JSON.stringify(payload, null, 2)};

  // Runs on every document, including about:blank and sandboxed frames where
  // storage access throws. Origin is "null" there, so bail out early.
  const origin = window.location.origin;
  if (!origin || origin === 'null') return;

  const apply = (store, entries) => {
    for (const [key, value] of Object.entries(entries)) {
      try {
        store.setItem(key, value);
      } catch {
        // Storage disabled or over quota for this origin - nothing to do.
      }
    }
  };

  apply(window.localStorage, STATE.localStorage[origin] ?? {});
  apply(window.sessionStorage, STATE.sessionStorage);
})();
`;

  fs.mkdirSync(path.dirname(INIT_SCRIPT_FILE), { recursive: true });
  fs.writeFileSync(INIT_SCRIPT_FILE, script);
  return INIT_SCRIPT_FILE;
}
