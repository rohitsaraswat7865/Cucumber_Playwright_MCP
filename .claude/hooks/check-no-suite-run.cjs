// Mechanical enforcement of CLAUDE.md N1 / §2 (never run the test suite,
// bddgen, or global setup). Runs as a PreToolUse hook on the shell tools
// (Bash, PowerShell, Monitor) and denies commands that would start any of them -
// the user's call, since the suite and global setup log in for real.
//
// Best-effort by design: it recognises the ordinary ways of starting a run (npm
// scripts, npx, the binaries directly, node global-setup.js), including inside
// `&&` chains, subshells and `bash -c "..."`, but not deliberate obfuscation.
// Quoted text and heredoc bodies are data rather than commands, so
// `grep "npx playwright test" README.md` is still allowed.
//
// Fails open: if this script itself breaks, the command goes through as it did
// before the hook existed, rather than blocking every shell call.
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

// Words that only prefix the real command (`CI=1`, `timeout 60`, `if`, ...).
const WRAPPERS = new Set([
  'env',
  'cross-env',
  'command',
  'exec',
  'nohup',
  'time',
  'timeout',
  'nice',
  'sudo',
  'call',
  'start',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
]);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
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
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits a command line into simple commands - on unquoted ; & | ( ) { },
 * backticks, $( and newlines - and each command into words, honouring single
 * and double quotes. Heredoc bodies are skipped: they're data being written
 * somewhere, not commands.
 */
function parseCommands(src) {
  const commands = [];
  const heredocs = [];
  let words = [];
  let word = null; // null until the current word has started
  let quote = null;

  const append = s => {
    word = (word ?? '') + s;
  };
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1]))
        append(src[++i]);
      else append(ch);
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= '';
      continue;
    }

    if (ch === '\\' && i + 1 < src.length) {
      const next = src[++i];
      if (next === '\n') continue; // line continuation
      // Escaped metacharacter -> literal; otherwise keep the backslash (Windows paths).
      append(/[\s'"\\;&|()<>{}`$]/.test(next) ? next : ch + next);
      continue;
    }

    if (ch === '#' && word === null) {
      // Comment to end of line (bash and PowerShell alike).
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
      continue;
    }

    if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<-?[ \t]*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(i));
      if (m) {
        endWord();
        heredocs.push(m[2]);
        i += m[0].length - 1;
        continue;
      }
    }

    if (ch === '\n') {
      endCommand();
      i = skipHeredocBodies(src, i, heredocs);
      continue;
    }

    if (ch === '$' && src[i + 1] === '(') {
      endCommand();
      i++;
      continue;
    }

    if (ch === '&') {
      // 2>&1, >&2 and &> are redirections, not command separators.
      if (src[i - 1] === '>' || src[i - 1] === '<' || src[i + 1] === '>') append(ch);
      else endCommand();
      continue;
    }

    if (';|(){}`'.includes(ch)) {
      endCommand();
      continue;
    }

    if (/\s/.test(ch)) {
      endWord();
      continue;
    }

    append(ch);
  }

  endCommand();
  return commands;
}

// Moves past the bodies of pending heredocs, which start on the line after the
// newline at index `i`. Returns the index of the newline ending the last
// delimiter line, or the end of the input.
function skipHeredocBodies(src, i, heredocs) {
  while (heredocs.length > 0) {
    const delimiter = heredocs.shift();
    for (;;) {
      if (i >= src.length) return src.length;
      const start = i + 1;
      let end = src.indexOf('\n', start);
      if (end === -1) end = src.length;
      i = end;
      if (src.slice(start, end).trim() === delimiter) break;
    }
  }
  return i;
}

// 'node_modules/.bin/playwright.cmd' -> 'playwright', 'playwright@1.50' ->
// 'playwright', and the package specs whose only bin is the runner / bddgen.
function binName(word) {
  const w = word.toLowerCase();
  if (/^@playwright\/test(@|$)/.test(w)) return 'playwright';
  const name = w
    .split(/[\\/]/)
    .pop()
    .replace(/\.(cmd|exe|bat|ps1)$/, '')
    .replace(/@.*$/, '');
  return name === 'playwright-bdd' ? 'bddgen' : name;
}

function positionals(args, valueFlags = new Set()) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

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
  // yarn and pnpm also run a script given just its name: `yarn test:debug`.
  if (pm !== 'npm' && scripts.has(sub)) return `the \`${sub}\` npm script`;
  return null;
}

function nodeReason(args, scripts) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (NODE_NO_SCRIPT_RUN.has(a)) return null;
    if (a === '--run' || a.startsWith('--run=')) {
      const script = a === '--run' ? args[i + 1] : a.slice('--run='.length);
      return script !== undefined && scripts.has(script) ? `the \`${script}\` npm script` : null;
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
    return null;
  }
  return null;
}

// What running `words` would start ('bddgen', 'global setup', ...), or null.
function blockedReason(words, scripts, depth = 0) {
  let i = 0;
  while (i < words.length) {
    if (words[i] === '' || ENV_ASSIGNMENT.test(words[i])) {
      i++;
    } else if (binName(words[i]) === 'command' && /^-[vV]$/.test(words[i + 1] ?? '')) {
      return null; // `command -v bddgen` only looks the command up
    } else if (WRAPPERS.has(binName(words[i]))) {
      i++;
      // Wrapper options and values: `timeout 60`, `nice -n 5`, `start /b`, `env -i`.
      while (i < words.length && /^(-|\d|\/[a-z]$)/i.test(words[i])) i++;
    } else {
      break;
    }
  }
  if (i >= words.length) return null;

  const cmd = binName(words[i]);
  const args = words.slice(i + 1);

  if (depth < 3) {
    // A shell's -c / /c / -Command argument is itself a command line.
    let inner = null;
    if (POSIX_SHELLS.has(cmd)) {
      const c = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a));
      if (c !== -1) inner = args[c + 1] ?? null;
    } else if (cmd === 'cmd') {
      const c = args.findIndex(a => /^\/[ck]$/i.test(a));
      if (c !== -1) inner = args.slice(c + 1).join(' ');
    } else if (cmd === 'powershell' || cmd === 'pwsh') {
      const c = args.findIndex(a => /^-(c|command)$/i.test(a));
      if (c !== -1) inner = args.slice(c + 1).join(' ');
    }
    if (inner !== null) {
      for (const innerWords of parseCommands(inner)) {
        const reason = blockedReason(innerWords, scripts, depth + 1);
        if (reason) return reason;
      }
      return null;
    }
  }

  if (cmd === 'bddgen') return 'bddgen';
  if (cmd === 'playwright') {
    return positionals(args)[0] === 'test' ? 'the Playwright test runner' : null;
  }
  if (cmd === 'npx' || cmd === 'pnpx' || cmd === 'bunx') return execReason(args);
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') {
    return packageManagerReason(cmd, args, scripts);
  }
  if (cmd === 'node') return nodeReason(args, scripts);
  return null;
}

// npm scripts that start a run: those whose body does, directly or by calling
// another such script. Read live from package.json, so a new wrapper script is
// covered without touching this hook.
function suiteScripts() {
  const names = new Set(['test', 'bddgen']);
  let scripts = {};
  try {
    scripts =
      JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8')).scripts ?? {};
  } catch {
    // No readable package.json - fall back to the fixed names above.
  }

  const runsSuite = body => parseCommands(body).some(words => blockedReason(words, names) !== null);

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

function deny(what, command) {
  const shown = command.length > 200 ? `${command.slice(0, 200)}...` : command;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Blocked by CLAUDE.md §2 (N1): \`${shown}\` would start ${what}. Running the suite, ` +
          "bddgen, or global setup is the user's call, not yours.\n" +
          'Hand off instead: tell the user what you completed, what is blocked plus the exact ' +
          'command that unblocks it (e.g. `npm run test:debug`), and what stays unverified ' +
          'until it runs. Then wait.',
      },
    }),
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  } catch {
    return; // no usable input - allow
  }
  if (!input || !SHELL_TOOLS.has(input.tool_name)) return;

  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || command === '') return;

  const scripts = suiteScripts();
  for (const words of parseCommands(command)) {
    const what = blockedReason(words, scripts);
    if (what) {
      deny(what, words.join(' '));
      return;
    }
  }
}

try {
  main();
} catch (err) {
  // Fail open (see header), but loudly enough that a broken guard gets noticed.
  process.stderr.write(`check-no-suite-run hook failed, command allowed: ${err && err.message}\n`);
  process.exitCode = 1;
}
