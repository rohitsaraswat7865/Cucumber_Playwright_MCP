// Mechanical enforcement of CLAUDE.md N1 / §2 (never run the test suite,
// bddgen, or global setup). Runs as a PreToolUse hook on the shell tools
// (Bash, PowerShell, Monitor) and denies commands that would start any of them -
// the user's call, since the suite and global setup log in for real.
//
// Best-effort by design: it recognises the ordinary ways of starting a run (npm
// scripts, npx, the binaries directly, node global-setup.js), including inside
// `&&` chains, subshells and `bash -c "..."`, and one level of indirection
// through a script file (`bash run.sh`, `node tools/x.js`, `.\run.ps1`) whose
// contents spell out a run - but not deliberate obfuscation. Quoted text and
// heredoc bodies are data rather than commands, so
// `grep "npx playwright test" README.md` is still allowed.
//
// Fails closed (hook-utils.cjs): if this script breaks, shell calls are denied
// until it's fixed, rather than silently unguarded.
'use strict';

const fs = require('fs');
const path = require('path');
const { runHook, PROJECT_DIR } = require('./hook-utils.cjs');
const {
  POSIX_SHELLS,
  parseCommands,
  binName,
  positionals,
  commandStart,
  innerCommandLine,
  stringLiterals,
} = require('./shell-parse.cjs');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const MAX_DEPTH = 3;
const SCRIPT_SCAN_MAX_BYTES = 256 * 1024;
const SHELL_SCRIPT = /\.(sh|bash|zsh|ps1|bat|cmd)$/i;
const JS_SCRIPT = /\.(js|mjs|cjs)$/i;

const TEST_ALIASES = new Set(['test', 't', 'tst']);
const RUN_ALIASES = new Set(['run', 'run-script', 'rum', 'urn']);
const EXEC_ALIASES = new Set(['exec', 'x', 'dlx']);
// Options that take a separate value, so the value isn't mistaken for a command.
const PM_VALUE_FLAGS = new Set([
  '--prefix',
  '-C',
  '--dir',
  '--workspace',
  '-w',
  '--filter',
  '-F',
  '--cwd',
  '--cache',
  '--userconfig',
  '--registry',
  '--loglevel',
]);
const NPX_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call']);
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--input-type',
  '--env-file',
  '--title',
]);
// Inline code, or a mode that never executes the script (`node --check x.js`).
const NODE_NO_SCRIPT_RUN = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '--check',
  '-h',
  '--help',
  '-v',
  '--version',
]);
const PS_VALUE_FLAGS = new Set([
  '-executionpolicy',
  '-ep',
  '-workingdirectory',
  '-wd',
  '-configurationname',
  '-inputformat',
  '-outputformat',
  '-windowstyle',
]);

// `npx <bin> ...`, `npm exec <bin> ...`
function execReason(args) {
  const [binary, sub] = positionals(args, NPX_VALUE_FLAGS);
  if (binary === undefined) return null;
  const name = binName(binary);
  if (name === 'bddgen') return 'bddgen';
  if (name === 'playwright' && sub === 'test') return 'the Playwright test runner';
  return null;
}

function packageManagerReason(pm, args, scripts) {
  const [sub, next] = positionals(args, PM_VALUE_FLAGS);
  if (sub === undefined) return null;
  if (TEST_ALIASES.has(sub)) return `\`${pm} test\``;
  if (RUN_ALIASES.has(sub)) {
    return next !== undefined && scripts.has(next) ? `the \`${next}\` npm script` : null;
  }
  if (EXEC_ALIASES.has(sub)) return execReason(args.slice(args.indexOf(sub) + 1));
  // yarn, pnpm and bun also run a script given just its name: `yarn test:debug`.
  if (pm !== 'npm' && scripts.has(sub)) return `the \`${sub}\` npm script`;
  return null;
}

function nodeReason(args, ctx, depth) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (NODE_NO_SCRIPT_RUN.has(a)) return null;
    if (a === '--run' || a.startsWith('--run=')) {
      const script = a === '--run' ? args[i + 1] : a.slice('--run='.length);
      return script !== undefined && ctx.scripts.has(script)
        ? `the \`${script}\` npm script`
        : null;
    }
    if (a.startsWith('-')) {
      if (NODE_VALUE_FLAGS.has(a)) i++;
      continue;
    }

    // First positional: the script node would run.
    const file = a.replace(/\\/g, '/').toLowerCase();
    if (/(^|\/)global-setup(\.js)?$/.test(file)) return 'global setup';
    if (/(^|\/)(\.bin\/bddgen|playwright-bdd\/dist\/cli\/index\.js)$/.test(file)) return 'bddgen';
    if (/(^|\/)(\.bin\/playwright|(@playwright\/test|playwright)\/cli\.js)$/.test(file)) {
      return positionals(args.slice(i + 1))[0] === 'test' ? 'the Playwright test runner' : null;
    }
    return scriptReason(a, ctx, depth) ?? scriptReason(`${a}.js`, ctx, depth);
  }
  return null;
}

function readScript(file, cwd) {
  try {
    const full = path.resolve(cwd, file);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > SCRIPT_SCAN_MAX_BYTES) return null;
    return { full, text: fs.readFileSync(full, 'utf-8') };
  } catch {
    return null;
  }
}

/**
 * What running a script file would start, or null. Shell scripts are parsed
 * like a command line. JS files are searched for string literals that spell
 * out a run - `execSync('npx playwright test')`, or one spread over several
 * literals as in `spawn('npx', ['playwright', 'test'])` - and for references
 * to global-setup.js. Only the file itself is read, not what it imports.
 */
function scriptReason(file, ctx, depth) {
  if (depth >= MAX_DEPTH || typeof file !== 'string') return null;
  const script = readScript(file, ctx.cwd);
  if (!script) return null;

  let reason = null;
  if (JS_SCRIPT.test(script.full)) {
    reason = jsReason(script.text, ctx, depth + 1);
  } else {
    for (const words of parseCommands(script.text)) {
      reason = blockedReason(words, ctx, depth + 1);
      if (reason) break;
    }
  }
  return reason ? `${reason} (via ${path.basename(script.full)})` : null;
}

function jsReason(text, ctx, depth) {
  const literals = stringLiterals(text);
  const groups = [];
  let group = [];
  literals.forEach((lit, i) => {
    if (i > 0 && /^[\s,[]*$/.test(text.slice(literals[i - 1].end, lit.start))) {
      group.push(lit.value);
    } else {
      if (group.length > 1) groups.push(group);
      group = [lit.value];
    }
  });
  if (group.length > 1) groups.push(group);

  for (const { value } of literals) {
    if (/(^|[\\/])global-setup(\.js)?$/i.test(value)) return 'global setup';
    for (const words of parseCommands(value)) {
      const reason = blockedReason(words, ctx, depth);
      if (reason) return reason;
    }
  }
  for (const words of groups) {
    const reason = blockedReason(words, ctx, depth);
    if (reason) return reason;
  }
  return null;
}

// What running `words` would start ('bddgen', 'global setup', ...), or null.
function blockedReason(words, ctx, depth = 0) {
  const i = commandStart(words);
  if (i === -1) return null;

  const raw = words[i];
  const cmd = binName(raw);
  const args = words.slice(i + 1);

  if (depth < MAX_DEPTH) {
    // A shell's -c / /c / -Command argument is itself a command line.
    const inner = innerCommandLine(cmd, args);
    if (inner !== null) {
      for (const innerWords of parseCommands(inner)) {
        const reason = blockedReason(innerWords, ctx, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
  }

  // A script run directly (`./run.sh`, `.\run.ps1`, `call run.bat`), sourced
  // (`. ./env.sh`, `source x.sh`) or handed to a shell (`bash run.sh`).
  if (SHELL_SCRIPT.test(raw)) return scriptReason(raw, ctx, depth);
  if (cmd === '.' || cmd === 'source' || POSIX_SHELLS.has(cmd)) {
    return scriptReason(positionals(args)[0], ctx, depth);
  }
  if (cmd === 'powershell' || cmd === 'pwsh') {
    const f = args.findIndex(a => /^-(f|file)$/i.test(a));
    return scriptReason(f !== -1 ? args[f + 1] : positionals(args, PS_VALUE_FLAGS)[0], ctx, depth);
  }

  if (cmd === 'bddgen') return 'bddgen';
  if (cmd === 'playwright') {
    return positionals(args)[0] === 'test' ? 'the Playwright test runner' : null;
  }
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') return execReason(args);
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') {
    return packageManagerReason(cmd, args, ctx.scripts);
  }
  if (cmd === 'node') return nodeReason(args, ctx, depth);
  return null;
}

// npm scripts that start a run: those whose body does, directly, by calling
// another such script, or through a script file. Read live from package.json,
// so a new wrapper script is covered without touching this hook.
function suiteScripts() {
  const names = new Set(['test', 'bddgen']);
  let scripts = {};
  try {
    scripts =
      JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8')).scripts ?? {};
  } catch {
    // No readable package.json - fall back to the fixed names above.
  }

  const ctx = { scripts: names, cwd: PROJECT_DIR };
  const runsSuite = body => parseCommands(body).some(words => blockedReason(words, ctx) !== null);

  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of Object.entries(scripts)) {
      if (!names.has(name) && typeof body === 'string' && runsSuite(body)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

runHook({
  name: 'check-no-suite-run',
  rule: '§2 (N1)',
  main(input, { deny }) {
    if (!SHELL_TOOLS.has(input.tool_name)) return;

    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string' || command === '') return;

    const ctx = {
      scripts: suiteScripts(),
      cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : PROJECT_DIR,
    };
    for (const words of parseCommands(command)) {
      const what = blockedReason(words, ctx);
      if (!what) continue;
      const joined = words.join(' ');
      const shown = joined.length > 200 ? `${joined.slice(0, 200)}...` : joined;
      deny(
        `Blocked by CLAUDE.md §2 (N1): \`${shown}\` would start ${what}. Running the suite, ` +
          "bddgen, or global setup is the user's call, not yours.\n" +
          'Hand off instead: tell the user what you completed, what is blocked plus the exact ' +
          'command that unblocks it (e.g. `npm run test:debug`), and what stays unverified ' +
          'until it runs. Then wait.',
        `would start ${what}`,
      );
      return;
    }
  },
});
