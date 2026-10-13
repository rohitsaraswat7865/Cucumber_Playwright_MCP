// Mechanical enforcement of CLAUDE.md §1 for shell reads (Bash, PowerShell,
// Monitor): the shell-side twin of the `Read(...)` rules in permissions.deny,
// using the same ❌ path rules from hook-utils.cjs.
//
//   - a read of a ❌ generated path (cat/head/tail/Get-Content/..., grep/rg on
//     a file, `< file`, a cp source, stat, a path literal in node -e / python -c)
//     -> deny. .auth/ gets its own message: it holds live session tokens, and
//     the §3 gate already validates it and reports the files' ages.
//
// Listing a directory (ls, dir, Get-ChildItem, find) is allowed - names only.
// Best-effort by design: it recognises the ordinary read commands, not every
// program that can read a file. Fails closed (hook-utils.cjs).
'use strict';

const { runHook, relToProject, classifyPath } = require('./hook-utils.cjs');
const {
  parseCommands,
  binName,
  positionals,
  commandStart,
  innerCommandLine,
  stringLiterals,
} = require('./shell-parse.cjs');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);
const MAX_DEPTH = 3;

// Every non-flag argument is a file that gets read.
const READ_COMMANDS = new Set([
  'cat',
  'tac',
  'type',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  'nl',
  'od',
  'xxd',
  'hexdump',
  'strings',
  'base64',
  'wc',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'comm',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'stat',
  'file',
  'get-content',
  'gc',
  'get-filehash',
  'format-hex',
  'import-csv',
  'select-string',
  'sls',
]);
// The first positional is a pattern or script, the rest are files - unless the
// pattern came in through a flag (`grep -e x f`, `awk -f prog f`).
const PATTERN_FIRST = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'findstr',
  'awk',
  'gawk',
  'sed',
  'jq',
]);
const PATTERN_FLAG = /^(-e|-f|--regexp|--file)(=|$)/;
// The source is read; the destination is the shell-write guard's business.
const COPY_COMMANDS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'install']);
const INLINE_CODE = new Map([
  ['node', /^(-e|--eval|-p|--print)$/],
  ['python', /^-c$/],
  ['python3', /^-c$/],
  ['py', /^-c$/],
]);
const REDIRECT_IN = /^\d*<(?![<&(])(.*)$/;

/** Files read by one simple command: [path, ...]. */
function readTargets(words, depth) {
  const targets = [];
  const plain = [];

  // Input redirection: `< f`, `<f`, `0< f`.
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT_IN.exec(words[i]);
    if (!m) plain.push(words[i]);
    else if (m[1]) targets.push(m[1]);
    else if (words[i + 1] !== undefined) targets.push(words[++i]);
  }

  const start = commandStart(plain);
  if (start === -1) return targets;
  const cmd = binName(plain[start]);
  const args = plain.slice(start + 1);

  if (depth < MAX_DEPTH) {
    const inner = innerCommandLine(cmd, args);
    if (inner !== null) {
      for (const innerWords of parseCommands(inner))
        targets.push(...readTargets(innerWords, depth + 1));
      return targets;
    }
  }

  if (READ_COMMANDS.has(cmd)) {
    targets.push(...args.filter(a => !a.startsWith('-')));
  } else if (PATTERN_FIRST.has(cmd)) {
    const files = positionals(args);
    targets.push(...(args.some(a => PATTERN_FLAG.test(a)) ? files : files.slice(1)));
  } else if (COPY_COMMANDS.has(cmd)) {
    const d = args.findIndex(a => /^-(destination|dest|d)$/i.test(a));
    if (d !== -1) {
      targets.push(...args.filter((a, i) => !a.startsWith('-') && i !== d + 1));
    } else {
      targets.push(...positionals(args).slice(0, -1));
    }
  } else if (INLINE_CODE.has(cmd)) {
    const flag = args.findIndex(a => INLINE_CODE.get(cmd).test(a));
    const code = flag !== -1 ? args[flag + 1] : undefined;
    if (typeof code === 'string') targets.push(...stringLiterals(code).map(l => l.value));
  }
  return targets;
}

runHook({
  name: 'check-shell-reads',
  rule: '§1',
  main(input, { deny }) {
    if (!SHELL_TOOLS.has(input.tool_name)) return;

    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string' || command === '') return;

    const hits = [];
    for (const words of parseCommands(command)) {
      for (const target of readTargets(words, 0)) {
        const rel = relToProject(target, input.cwd);
        const hit = rel === null ? null : classifyPath(rel);
        if (hit && hit.kind === 'generated') hits.push(rel);
      }
    }
    if (hits.length === 0) return;

    const auth = hits.find(rel => rel.split('/').some(s => s.toLowerCase() === '.auth'));
    deny(
      auth
        ? `Blocked by CLAUDE.md §3 (N2): this command reads ${auth}. .auth/ holds live session ` +
            'tokens - never read or stat it. The §3 gate already validates it on every browser ' +
            "call and reports each file's age when it fails."
        : `Blocked by CLAUDE.md §1: this command reads ${hits[0]}, which is generated output - ` +
            'reads of ❌ paths are denied, through file tools or the shell. Work from the source ' +
            '(.feature, steps/, package.json), or ask the user for what you need from it.',
      hits.join(', '),
    );
  },
});
