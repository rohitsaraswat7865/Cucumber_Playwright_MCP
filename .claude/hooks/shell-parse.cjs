// Shell command-line parsing shared by the shell-tool hooks
// (check-no-suite-run.cjs, check-shell-writes.cjs). Best-effort by design: it
// understands the ordinary ways commands are written in bash and PowerShell,
// not deliberate obfuscation.
'use strict';

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
  '&', // PowerShell call operator: `& .\run.ps1`
]);
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
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
      // A lone `&` starting a command is PowerShell's call operator: keep it as a word.
      else if (word === null && words.length === 0 && /\s/.test(src[i + 1] ?? '')) words.push('&');
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

/**
 * Index of the real command in `words`, past env assignments and wrappers
 * (`CI=1 timeout 60 npx ...`); -1 when there's none, or when the command only
 * looks another one up (`command -v bddgen`).
 */
function commandStart(words) {
  let i = 0;
  while (i < words.length) {
    if (words[i] === '' || ENV_ASSIGNMENT.test(words[i])) {
      i++;
    } else if (binName(words[i]) === 'command' && /^-[vV]$/.test(words[i + 1] ?? '')) {
      return -1;
    } else if (WRAPPERS.has(binName(words[i]))) {
      i++;
      // Wrapper options and values: `timeout 60`, `nice -n 5`, `start /b`, `env -i`.
      while (i < words.length && /^(-|\d|\/[a-z]$)/i.test(words[i])) i++;
    } else {
      break;
    }
  }
  return i < words.length ? i : -1;
}

/** The command line a shell is told to run via -c / /c / -Command, or null. */
function innerCommandLine(cmd, args) {
  if (POSIX_SHELLS.has(cmd)) {
    const c = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a));
    return c !== -1 ? (args[c + 1] ?? null) : null;
  }
  if (cmd === 'cmd') {
    const c = args.findIndex(a => /^\/[ck]$/i.test(a));
    return c !== -1 ? args.slice(c + 1).join(' ') : null;
  }
  if (cmd === 'powershell' || cmd === 'pwsh') {
    const c = args.findIndex(a => /^-(c|command)$/i.test(a));
    return c !== -1 ? args.slice(c + 1).join(' ') : null;
  }
  return null;
}

// Single-line '...' / "..." literals and `...` without interpolation.
const STRING_LITERAL = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\$])*)`/g;

/** String literals in JS / inline code, in order: [{ value, start, end }]. */
function stringLiterals(text) {
  return Array.from(text.matchAll(STRING_LITERAL), m => ({
    value: m[1] ?? m[2] ?? m[3],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

module.exports = {
  POSIX_SHELLS,
  parseCommands,
  binName,
  positionals,
  commandStart,
  innerCommandLine,
  stringLiterals,
};
