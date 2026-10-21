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

test('check-shell-writes: denies generated paths, asks for the harness and steps/', () => {
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

test('check-shell-reads: denies reads of generated paths, allows listings and other files', () => {
  const dir = makeProject();
  for (const [expected, commands] of Object.entries(fixtures.shellReads)) {
    for (const command of commands) {
      for (const tool of ['Bash', 'PowerShell']) {
        expectDecision(
          dir,
          'check-shell-reads.cjs',
          { tool_name: tool, tool_input: { command } },
          expected,
          `${tool}: ${command}`,
        );
      }
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

// ---------------------------------------------------------------- N7 (§9)

const menu = (overrides = {}) => ({
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'What would you like to do?',
        header: 'Start',
        multiSelect: false,
        options: [
          { label: 'Implement TODO steps', description: 'Fill in the TODO stubs' },
          { label: 'Exit', description: 'Do nothing' },
        ],
        ...overrides,
      },
    ],
  },
});

test('check-session-menu: blocks every tool until the start menu is shown', () => {
  const dir = makeProject();
  const session_id = `hooks-test-${process.pid}-${Date.now()}`;
  const run = (input, expected, label) =>
    expectDecision(dir, 'check-session-menu.cjs', { session_id, ...input }, expected, label);

  run({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }, 'deny', 'Read first');
  run({ tool_name: 'ToolSearch', tool_input: { query: 'x' } }, 'deny', 'ToolSearch first');
  run(menu({ question: 'Something else?' }), 'deny', 'a different question');
  run(
    menu({ options: [{ label: 'Implement TODO steps', description: '' }] }),
    'deny',
    'the menu missing Exit',
  );
  run(menu(), 'allow', 'the menu');
  run({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }, 'allow', 'Read after');
  run({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'allow', 'Bash after');

  expectDecision(
    dir,
    'check-session-menu.cjs',
    { session_id: `${session_id}-other`, tool_name: 'Read', tool_input: {} },
    'deny',
    'another session is still locked',
  );
  expectDecision(
    dir,
    'check-session-menu.cjs',
    { tool_name: 'Read', tool_input: {} },
    'deny',
    'no session_id fails closed',
  );
  fs.rmSync(path.join(os.tmpdir(), 'claude-session-menu', session_id), { force: true });
});

test('check-todo-steps: TODO stubs re-lock the start menu on every prompt', () => {
  const stub = "Given('a stub', async () => {\n  // TODO\n});\n";
  const done = "Given('done', async () => {\n  await 1;\n});\n";
  const session_id = `hooks-todo-${process.pid}-${Date.now()}`;
  const marker = path.join(os.tmpdir(), 'claude-session-menu', session_id);
  const prompt = dir => {
    const result = spawnSync(
      process.execPath,
      [path.join(dir, '.claude', 'hooks', 'check-todo-steps.cjs')],
      {
        input: JSON.stringify({ cwd: dir, session_id, prompt: 'hi' }),
        encoding: 'utf-8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
  };
  const unlock = () => {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
  };

  const clean = makeProject({ 'steps/a.steps.js': done });
  unlock();
  assert.equal(prompt(clean), null, 'no stubs: no output');
  assert.ok(fs.existsSync(marker), 'no stubs: menu stays unlocked');

  const todo = makeProject({ 'steps/a.steps.js': done, 'steps/b.steps.js': stub });
  const out = prompt(todo);
  assert.match(out.hookSpecificOutput.additionalContext, /"a stub" \(steps\/b\.steps\.js\)/);
  assert.ok(!fs.existsSync(marker), 'stubs: marker cleared, so the menu is demanded again');

  const broken = makeProject({ 'steps/c.steps.js': "Given('x', async () => {" });
  assert.equal(prompt(broken).decision, 'block', 'unparseable steps file fails closed');
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
    'check-shell-reads.cjs',
    'check-generated-files.cjs',
    'check-step-edits.cjs',
    'check-session-gate.cjs',
    'check-session-menu.cjs',
  ]) {
    expectDecision(dir, script, '{not json', 'deny', script);
  }

  // A UserPromptSubmit hook answers with decision: 'block' instead of a permission decision.
  const result = spawnSync(
    process.execPath,
    [path.join(dir, '.claude', 'hooks', 'check-todo-steps.cjs')],
    { input: '{not json', encoding: 'utf-8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block', 'check-todo-steps.cjs');
});

test('check-session-menu: prunes markers older than a week when it writes a new one', () => {
  const dir = makeProject();
  const markerDir = path.join(os.tmpdir(), 'claude-session-menu');
  const stamp = `${process.pid}-${Date.now()}`;
  const old = path.join(markerDir, `hooks-old-${stamp}`);
  const recent = path.join(markerDir, `hooks-recent-${stamp}`);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(old, '');
  fs.writeFileSync(recent, '');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);

  const session_id = `hooks-new-${stamp}`;
  expectDecision(dir, 'check-session-menu.cjs', { session_id, ...menu() }, 'allow', 'the menu');
  assert.ok(!fs.existsSync(old), 'a week-old marker is removed');
  assert.ok(fs.existsSync(recent), 'a recent marker is kept');
  for (const f of [recent, path.join(markerDir, session_id)]) fs.rmSync(f, { force: true });
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

// The §9 start-menu guard runs on every tool; hooksFor() leaves it out so the
// per-tool assertions below stay focused, and the wiring test checks it separately.
function hooksFor(toolName) {
  return settingsHooks()
    .filter(h => h.matcher.test(toolName))
    .map(h => /([\w-]+\.cjs)/.exec(h.command)?.[1])
    .filter(name => name !== 'check-session-menu.cjs');
}

test('settings.json wires every hook to its tools, failing closed if it cannot load', () => {
  for (const tool of [
    'Read',
    'AskUserQuestion',
    'Bash',
    'Edit',
    'mcp__playwright__browser_snapshot',
  ]) {
    assert.ok(
      settingsHooks().some(h => h.matcher.test(tool) && /check-session-menu\.cjs/.test(h.command)),
      `check-session-menu.cjs is not wired to ${tool}`,
    );
  }
  for (const tool of ['Bash', 'PowerShell', 'Monitor']) {
    assert.deepEqual(
      hooksFor(tool).sort(),
      ['check-no-suite-run.cjs', 'check-shell-reads.cjs', 'check-shell-writes.cjs'],
      tool,
    );
  }
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

  // The §9 TODO-step check runs on every prompt, not on tools.
  const settings = JSON.parse(
    fs.readFileSync(path.join(REPO_DIR, '.claude', 'settings.json'), 'utf-8'),
  );
  const promptHooks = (settings.hooks.UserPromptSubmit ?? []).flatMap(e => e.hooks);
  assert.deepEqual(
    promptHooks.map(h => /([\w-]+\.cjs)/.exec(h.command)?.[1]),
    ['check-todo-steps.cjs'],
    'UserPromptSubmit',
  );
  for (const { command } of promptHooks) {
    assert.match(command, /catch\(e\)\{.*decision:'block'/, `no fail-closed wrapper: ${command}`);
  }
});

// CLAUDE.md §1: the ❌ generated-path list is mirrored by hand in several files.
test('every copy of the generated-path list matches hook-utils.cjs', () => {
  const { GENERATED, HOOK_LOG } = require(path.join(HOOKS_DIR, 'hook-utils.cjs'));
  const read = rel => fs.readFileSync(path.join(REPO_DIR, rel), 'utf-8');
  const lines = rel =>
    new Set(
      read(rel)
        .split(/\r?\n/)
        .map(l => l.trim()),
    );
  // `.auth` -> `.auth/`, `package-lock.json` -> itself.
  const entry = name => (/^[^.].*\.\w+$/.test(name) ? name : `${name}/`);
  const names = Object.keys(GENERATED);
  const hookLog = `${HOOK_LOG}*`;

  const gitignore = lines('.gitignore');
  const prettierignore = lines('.prettierignore');
  const deny = JSON.parse(read('.claude/settings.json')).permissions.deny.map(r =>
    r.replace(/^Read\((?:\*\*\/)?/, '').replace(/\*\*\)$|\)$/g, ''),
  );
  const claudeRow = read('CLAUDE.md')
    .split('\n')
    .find(l => l.includes('❌ never (N4)'));
  const eslint = read('eslint.config.js');
  assert.ok(claudeRow, 'CLAUDE.md §1 has no "❌ never (N4)" row');

  for (const name of names) {
    const e = entry(name);
    // package-lock.json is generated but tracked, so git must not ignore it.
    if (name === 'package-lock.json') assert.ok(!gitignore.has(e), `.gitignore ignores ${e}`);
    else assert.ok(gitignore.has(e), `.gitignore is missing ${e}`);
    assert.ok(prettierignore.has(e), `.prettierignore is missing ${e}`);
    assert.ok(deny.includes(e), `permissions.deny in .claude/settings.json is missing ${e}`);
    assert.ok(claudeRow.includes(`\`${e}\``), `CLAUDE.md §1 ❌ row is missing ${e}`);
    if (e.endsWith('/')) assert.ok(eslint.includes(`'${e}'`), `eslint.config.js ignores miss ${e}`);
  }
  assert.ok(gitignore.has(hookLog), `.gitignore is missing ${hookLog}`);
  assert.ok(prettierignore.has(hookLog), `.prettierignore is missing ${hookLog}`);
  assert.ok(deny.includes(hookLog), `permissions.deny is missing ${hookLog}`);
  assert.ok(claudeRow.includes(`\`${hookLog}\``), `CLAUDE.md §1 ❌ row is missing ${hookLog}`);
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

test('no Playwright MCP server in .mcp.json enables --caps=storage', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(REPO_DIR, '.mcp.json'), 'utf-8'));
  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    const args = server.args ?? [];
    args.forEach((a, i) => {
      if (!/^--caps(=|$)/.test(a)) return;
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[i + 1] ?? '');
      assert.ok(
        !value
          .split(',')
          .map(c => c.trim())
          .includes('storage'),
        `server "${name}" enables --caps=storage - CLAUDE.md §7: --init-script already seeds storage`,
      );
    });
  }
});
