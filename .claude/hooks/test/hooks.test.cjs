// Self-tests for the PreToolUse hooks in .claude/hooks/. Run with
// `npm run hooks:test`. Each test copies the hooks into a throwaway project
// under the OS temp dir and feeds them hook input on stdin, exactly as Claude
// Code does - nothing here touches the real .auth/, runs the suite or logs in.
//
// Command lines and file contents live in fixtures.json, not in this file:
// check-no-suite-run.cjs scans a node script for literals that spell out a
// run, and would otherwise block this very test.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(HOOKS_DIR, '..', '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf-8'));

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeProject(extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  for (const f of fs.readdirSync(HOOKS_DIR)) {
    if (f.endsWith('.cjs'))
      write(dir, path.join('.claude', 'hooks', f), fs.readFileSync(path.join(HOOKS_DIR, f)));
  }
  fs.copyFileSync(path.join(REPO_DIR, 'session-state.js'), path.join(dir, 'session-state.js'));
  write(dir, 'package.json', JSON.stringify(fixtures.packageJson, null, 2));
  for (const [rel, content] of Object.entries({ ...fixtures.files, ...extraFiles })) {
    write(dir, rel, content);
  }
  return dir;
}

/** Runs one hook; returns 'allow', 'ask' or 'deny' plus the reason. */
function runHook(dir, script, input) {
  const result = spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', script)], {
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: dir, ...input }),
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, `${script} exited ${result.status}: ${result.stderr}`);
  if (result.stdout.trim() === '') return { decision: 'allow', reason: '' };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
}

function expectDecision(dir, script, input, expected, label) {
  const { decision, reason } = runHook(dir, script, input);
  assert.equal(decision, expected, `${label}\n  got ${decision}: ${reason}`);
  return reason;
}

// ---------------------------------------------------------------- N1 (§2)

test('check-no-suite-run: blocks suite runs, allows everything else', () => {
  const dir = makeProject();
  for (const [expected, commands] of Object.entries(fixtures.noSuiteRun)) {
    for (const command of commands) {
      for (const tool of ['Bash', 'PowerShell']) {
        expectDecision(
          dir,
          'check-no-suite-run.cjs',
          { tool_name: tool, tool_input: { command } },
          expected,
          `${tool}: ${command}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------- N4 (§1)

test('check-shell-writes: denies generated paths, asks for the harness', () => {
  const dir = makeProject();
  for (const [expected, commands] of Object.entries(fixtures.shellWrites)) {
    for (const command of commands) {
      expectDecision(
        dir,
        'check-shell-writes.cjs',
        { tool_name: 'Bash', tool_input: { command } },
        expected,
        command,
      );
    }
  }
});

test('check-generated-files: denies generated paths, asks for the harness', () => {
  const dir = makeProject();
  for (const [expected, files] of Object.entries(fixtures.fileEdits)) {
    for (const rel of files) {
      for (const tool of ['Edit', 'Write']) {
        expectDecision(
          dir,
          'check-generated-files.cjs',
          { tool_name: tool, tool_input: { file_path: rel } },
          expected,
          `${tool}: ${rel}`,
        );
        // Absolute paths resolve the same way.
        expectDecision(
          dir,
          'check-generated-files.cjs',
          { tool_name: tool, tool_input: { file_path: path.join(dir, rel) } },
          expected,
          `${tool}: absolute ${rel}`,
        );
      }
    }
  }
  expectDecision(
    dir,
    'check-generated-files.cjs',
    { tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'outside.json') } },
    'allow',
    'a path outside the project',
  );
});

// ---------------------------------------------------------------- N6 (§4)

test('check-step-edits: only new steps and approved TODO stubs get through', () => {
  for (const c of fixtures.steps.cases) {
    const dir = makeProject(fixtures.steps.files);
    expectDecision(
      dir,
      'check-step-edits.cjs',
      { tool_name: c.tool, tool_input: c.input },
      c.expect,
      c.name,
    );
  }
});

// ---------------------------------------------------------------- N2 (§3)

const COOKIE_SECRET = 'cookie-value-that-must-never-be-logged';

function sessionFiles(dir, { state = {}, initPayload, ageHours = 0 } = {}) {
  const base = {
    cookies: [
      { name: 'sid', value: COOKIE_SECRET, domain: '.example.com', path: '/', expires: -1 },
    ],
    origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'k', value: 'v' }] }],
    sessionStorage: { s: '1' },
  };
  const session = { ...base, ...state };
  for (const [k, v] of Object.entries(state)) if (v === undefined) delete session[k];
  const payload = initPayload ?? {
    localStorage: { 'https://app.example.com': { k: 'v' } },
    sessionStorage: { s: '1' },
  };
  const files = [
    write(dir, '.auth/session.json', JSON.stringify(session, null, 2)),
    write(
      dir,
      '.auth/session.init.js',
      `(() => {\n  const STATE = ${JSON.stringify(payload, null, 2)};\n})();\n`,
    ),
  ];
  if (ageHours > 0) {
    const when = new Date(Date.now() - ageHours * 3.6e6);
    for (const f of files) fs.utimesSync(f, when, when);
  }
}

const browser = (tool, toolInput = {}) => ({
  tool_name: `mcp__playwright__browser_${tool}`,
  tool_input: toolInput,
});

test('check-session-gate: passes a fresh, consistent session', () => {
  const dir = makeProject();
  sessionFiles(dir);
  expectDecision(dir, 'check-session-gate.cjs', browser('snapshot'), 'allow', 'snapshot');
  expectDecision(
    dir,
    'check-session-gate.cjs',
    browser('navigate', { url: 'https://app.example.com/home' }),
    'allow',
    'navigate to a covered host',
  );
  expectDecision(
    dir,
    'check-session-gate.cjs',
    browser('navigate', { url: 'about:blank' }),
    'allow',
    'about:blank',
  );
});

test('check-session-gate: denies each kind of bad session', () => {
  const cases = [
    ['missing files', () => {}],
    ['stale files', dir => sessionFiles(dir, { ageHours: 2 })],
    [
      'expired cookie',
      dir =>
        sessionFiles(dir, {
          state: {
            cookies: [
              {
                name: 'sid',
                value: COOKIE_SECRET,
                domain: '.example.com',
                path: '/',
                expires: 1000,
              },
            ],
          },
        }),
    ],
    [
      'missing sessionStorage field',
      dir => sessionFiles(dir, { state: { sessionStorage: undefined } }),
    ],
    [
      'non-native shape',
      dir =>
        sessionFiles(dir, { state: { origins: undefined, origin: 'https://app.example.com' } }),
    ],
    [
      'init script out of step',
      dir =>
        sessionFiles(dir, {
          initPayload: {
            localStorage: { 'https://app.example.com': { k: 'v' } },
            sessionStorage: { s: '2' },
          },
        }),
    ],
    [
      'init script not generated',
      dir => {
        sessionFiles(dir);
        write(dir, '.auth/session.init.js', '// hand-written\n');
      },
    ],
  ];
  for (const [name, setup] of cases) {
    const dir = makeProject();
    setup(dir);
    expectDecision(dir, 'check-session-gate.cjs', browser('snapshot'), 'deny', name);
  }

  const dir = makeProject();
  sessionFiles(dir);
  const reason = expectDecision(
    dir,
    'check-session-gate.cjs',
    browser('navigate', { url: 'https://other.test/' }),
    'deny',
    'navigate to an uncovered host',
  );
  assert.match(reason, /other\.test/);
});

test('check-session-gate: browser_close is never gated', () => {
  const dir = makeProject();
  expectDecision(dir, 'check-session-gate.cjs', browser('close'), 'allow', 'close with no session');
  expectDecision(
    dir,
    'check-session-gate.cjs',
    browser('snapshot'),
    'deny',
    'snapshot with no session',
  );
});

// ---------------------------------------------------------------- fail closed + audit log

test('every hook fails closed on unreadable input', () => {
  const dir = makeProject();
  for (const script of [
    'check-no-suite-run.cjs',
    'check-shell-writes.cjs',
    'check-generated-files.cjs',
    'check-step-edits.cjs',
    'check-session-gate.cjs',
  ]) {
    expectDecision(dir, script, '{not json', 'deny', script);
  }
});

test('denials are audit-logged without secrets', () => {
  const dir = makeProject();
  sessionFiles(dir, { ageHours: 2 });
  expectDecision(dir, 'check-session-gate.cjs', browser('snapshot'), 'deny', 'stale session');
  expectDecision(
    dir,
    'check-generated-files.cjs',
    { tool_name: 'Edit', tool_input: { file_path: '.auth/session.json' } },
    'deny',
    'edit .auth',
  );

  const log = fs.readFileSync(path.join(dir, '.claude', 'hooks', 'hook.log'), 'utf-8');
  const entries = log
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.deepEqual(
    entries.map(e => [e.hook, e.decision]),
    [
      ['check-session-gate', 'deny'],
      ['check-generated-files', 'deny'],
    ],
  );
  assert.ok(!log.includes(COOKIE_SECRET), 'the log must not contain cookie values');
});
// ---------------------------------------------------------------- wiring in the real repo

function settingsHooks() {
  const settings = JSON.parse(
    fs.readFileSync(path.join(REPO_DIR, '.claude', 'settings.json'), 'utf-8'),
  );
  return settings.hooks.PreToolUse.flatMap(entry =>
    entry.hooks.map(h => ({ matcher: new RegExp(`^(?:${entry.matcher})$`), command: h.command })),
  );
}

function hooksFor(toolName) {
  return settingsHooks()
    .filter(h => h.matcher.test(toolName))
    .map(h => /([\w-]+\.cjs)/.exec(h.command)?.[1]);
}

test('settings.json wires every hook to its tools, failing closed if it cannot load', () => {
  assert.deepEqual(hooksFor('Bash').sort(), ['check-no-suite-run.cjs', 'check-shell-writes.cjs']);
  assert.deepEqual(hooksFor('PowerShell').sort(), [
    'check-no-suite-run.cjs',
    'check-shell-writes.cjs',
  ]);
  assert.deepEqual(hooksFor('Monitor').sort(), [
    'check-no-suite-run.cjs',
    'check-shell-writes.cjs',
  ]);
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    assert.deepEqual(
      hooksFor(tool).sort(),
      ['check-generated-files.cjs', 'check-step-edits.cjs'],
      tool,
    );
  }
  assert.deepEqual(hooksFor('NotebookEdit'), ['check-generated-files.cjs']);
  for (const { command } of settingsHooks()) {
    assert.match(
      command,
      /catch\(e\)\{.*permissionDecision:'deny'/,
      `no fail-closed wrapper: ${command}`,
    );
  }
});

test('the §3 gate matcher covers every Playwright MCP server in .mcp.json', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.mcp.json'), 'utf-8'));
  const servers = Object.entries(mcp.mcpServers).filter(([, s]) =>
    (s.args ?? []).some(a => /@playwright\/mcp/.test(a)),
  );
  assert.ok(servers.length > 0, 'no Playwright MCP server found in .mcp.json');
  for (const [name] of servers) {
    assert.deepEqual(
      hooksFor(`mcp__${name}__browser_snapshot`),
      ['check-session-gate.cjs'],
      `server "${name}" is not gated - update the matcher in .claude/settings.json`,
    );
  }
});
