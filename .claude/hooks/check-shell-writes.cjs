// Mechanical enforcement of CLAUDE.md N4 / §1 for the shell tools (Bash,
// PowerShell, Monitor): the shell-side twin of check-generated-files.cjs, using
// the same path rules from hook-utils.cjs.
//
//   - a write into a ❌ generated path (redirect, rm/mv/cp/touch/tee, sed -i,
//     Set-Content/Out-File/Remove-Item/..., node -e writeFileSync(...)) -> deny
//   - a write into the harness (.claude/settings*.json, .claude/hooks/,
//     session-state.js, .mcp.json) -> ask, so the user approves it
//
// Best-effort by design: it recognises the ordinary write commands, not every
// program that can write a file. Reads are allowed. Fails closed (hook-utils.cjs).
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

// Every path argument is a write target.
const WRITE_COMMANDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'del',
  'erase',
  'rd',
  'mv',
  'move',
  'ren',
  'rename',
  'touch',
  'tee',
  'truncate',
  'shred',
  'ln',
  'chmod',
  'chown',
  'remove-item',
  'ri',
  'move-item',
  'mi',
  'rename-item',
  'rni',
  'set-content',
  'sc',
  'add-content',
  'ac',
  'clear-content',
  'clc',
  'out-file',
  'new-item',
  'ni',
]);
// Only the destination is written; the source is just read.
const COPY_COMMANDS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'install']);
// Write only with an in-place flag: `sed -i`, `perl -pi -e`.
const IN_PLACE_COMMANDS = new Set(['sed', 'perl', 'gsed']);
// Inline code that can write files when it mentions a path.
const INLINE_CODE = new Map([
  ['node', /^(-e|--eval|-p|--print)$/],
  ['python', /^-c$/],
  ['python3', /^-c$/],
  ['py', /^-c$/],
]);
const CODE_WRITES =
  /\b(writeFile|appendFile|rm|rmdir|unlink|rename|copyFile|cp|truncate|createWriteStream|mkdir|write_text|write_bytes|remove|rmtree|move)\w*\s*\(|\bopen\s*\([^)]*['"][wa]/;
const REDIRECT = /^(?:\d+|&|\*)?>>?(?!&)(.*)$/;

/** Write targets in one simple command: [path, ...]. */
function writeTargets(words, depth) {
  const targets = [];
  const plain = [];

  // Redirections: `> f`, `>> f`, `>f`, `2> f`, `*> f` (PowerShell).
  for (let i = 0; i < words.length; i++) {
    const m = REDIRECT.exec(words[i]);
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
        targets.push(...writeTargets(innerWords, depth + 1));
      return targets;
    }
  }

  if (WRITE_COMMANDS.has(cmd)) {
    targets.push(...args.filter(a => !a.startsWith('-')));
  } else if (COPY_COMMANDS.has(cmd)) {
    const d = args.findIndex(a => /^-(destination|dest|d)$/i.test(a));
    const destination = d !== -1 ? args[d + 1] : positionals(args).pop();
    if (destination !== undefined) targets.push(destination);
  } else if (IN_PLACE_COMMANDS.has(cmd)) {
    if (args.some(a => /^-[a-z]*i/.test(a) || a.startsWith('--in-place'))) {
      targets.push(...positionals(args).slice(cmd === 'perl' ? 0 : 1));
    }
  } else if (cmd === 'dd') {
    for (const a of args) if (a.startsWith('of=')) targets.push(a.slice(3));
  } else if (INLINE_CODE.has(cmd)) {
    const flag = args.findIndex(a => INLINE_CODE.get(cmd).test(a));
    const code = flag !== -1 ? args[flag + 1] : undefined;
    if (typeof code === 'string' && CODE_WRITES.test(code)) {
      targets.push(...stringLiterals(code).map(l => l.value));
    }
  }
  return targets;
}

runHook({
  name: 'check-shell-writes',
  rule: '§1 (N4)',
  main(input, { deny, ask }) {
    if (!SHELL_TOOLS.has(input.tool_name)) return;

    const command = input.tool_input && input.tool_input.command;
    if (typeof command !== 'string' || command === '') return;

    const generated = [];
    const harness = [];
    for (const words of parseCommands(command)) {
      for (const target of writeTargets(words, 0)) {
        const rel = relToProject(target, input.cwd);
        const hit = rel === null ? null : classifyPath(rel);
        if (hit && hit.kind === 'generated') generated.push({ rel, why: hit.why });
        if (hit && hit.kind === 'protected') harness.push({ rel, why: hit.why });
      }
    }

    if (generated.length > 0) {
      const { rel, why } = generated[0];
      deny(
        `Blocked by CLAUDE.md §1 (N4): this command writes to ${rel}, which is generated output - ` +
          `never hand-edit it, through file tools or the shell. ${why}.`,
        generated.map(g => g.rel).join(', '),
      );
    } else if (harness.length > 0) {
      const { rel, why } = harness[0];
      ask(
        `CLAUDE.md §1: this command writes to ${rel}, part of the harness (${why}). Claude may ` +
          'change the harness only when you explicitly asked for that change - approve only if you did.',
        harness.map(h => h.rel).join(', '),
      );
    }
  },
});
