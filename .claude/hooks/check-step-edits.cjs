// Mechanical enforcement of CLAUDE.md N6 / §4 (never edit an existing step
// definition; only add new ones). Runs as a PreToolUse hook on Claude's
// file-editing tools for steps/**/*.js: it applies the edit to the file's
// current contents in memory, finds every Given/When/Then/Step registration
// before and after, and compares them.
//
//   - an existing step removed, renamed or changed (beyond whitespace, quote
//     style and trailing commas)                       -> deny
//   - a new step whose text another step already uses -> deny (playwright-bdd
//     treats it as a duplicate definition, not an override)
//   - an empty `// TODO` stub filled in, text and parameters unchanged -> ask:
//     §4 allows it only once the user agrees
//   - steps added, or code outside step bodies changed -> allowed
//
// Covers Claude's file tools only; shell writes to steps/ aren't inspected.
// Fails closed (hook-utils.cjs); a file it can't parse turns into an ask.
'use strict';

const fs = require('fs');
const path = require('path');
const { runHook, PROJECT_DIR, relToProject } = require('./hook-utils.cjs');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const STEPS_FILE = /^steps\/(.+\/)?[^/]+\.js$/i;
const STEP_CALL = /(?<![\w$.])(Given|When|Then|Step)\s*\(/g;

/**
 * Two same-length copies of `src`: `noComments` with comments blanked, and
 * `codeOnly` with string contents blanked as well, so indices line up and
 * brackets inside strings or comments can't confuse the matching below.
 * Throws on an unterminated string or comment.
 */
function blank(src) {
  const noComments = src.split('');
  const codeOnly = src.split('');
  const templateDepth = []; // brace depth inside each open `${`
  let mode = 'code';
  const clear = (i, both = true) => {
    if (src[i] === '\n') return;
    codeOnly[i] = ' ';
    if (both) noComments[i] = ' ';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line';
        clear(i);
      } else if (ch === '/' && next === '*') {
        mode = 'block';
        clear(i);
        clear(++i);
      } else if (ch === "'" || ch === '"' || ch === '`') {
        mode = ch;
      } else if (templateDepth.length > 0 && ch === '{') {
        templateDepth[templateDepth.length - 1]++;
      } else if (templateDepth.length > 0 && ch === '}') {
        if (templateDepth[templateDepth.length - 1] === 0) {
          templateDepth.pop();
          mode = '`';
        } else {
          templateDepth[templateDepth.length - 1]--;
        }
      }
    } else if (mode === 'line') {
      if (ch === '\n') mode = 'code';
      else clear(i);
    } else if (mode === 'block') {
      clear(i);
      if (ch === '*' && next === '/') {
        clear(++i);
        mode = 'code';
      }
    } else if (ch === '\\') {
      clear(i, false);
      clear(++i, false);
    } else if (ch === mode) {
      mode = 'code';
    } else if (mode === '`' && ch === '$' && next === '{') {
      templateDepth.push(0);
      mode = 'code';
      i++;
    } else if (ch === '\n' && mode !== '`') {
      throw new Error(`unterminated string on line ${src.slice(0, i).split('\n').length}`);
    } else {
      clear(i, false);
    }
  }
  if (mode !== 'code' && mode !== 'line') throw new Error('unterminated string or comment');
  return { noComments: noComments.join(''), codeOnly: codeOnly.join('') };
}

function matchForward(code, open, o, c) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

function matchBackward(code, close, o, c) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === c) depth++;
    else if (code[i] === o && --depth === 0) return i;
  }
  return -1;
}

// Insensitive to what Prettier changes: whitespace, quote style, trailing commas.
const normalize = s =>
  s
    .replace(/\s+/g, '')
    .replace(/"/g, "'")
    .replace(/,([)\]}])/g, '$1');

/** Every step registration in `src`: [{ keyword, text, normalized, header, stub }]. */
function findSteps(src) {
  const { noComments, codeOnly } = blank(src);
  const steps = [];
  let lastEnd = 0;

  for (const m of codeOnly.matchAll(STEP_CALL)) {
    if (m.index < lastEnd) continue; // a call nested inside another step
    const open = m.index + m[0].length - 1;
    const close = matchForward(codeOnly, open, '(', ')');
    if (close === -1) throw new Error(`unbalanced parentheses after ${m[1]}( `);

    // The first argument is the step text: a string literal (or a regex/expression).
    const argStart = open + 1 + codeOnly.slice(open + 1).search(/\S/);
    let argEnd = argStart;
    let depth = 0;
    for (; argEnd < close; argEnd++) {
      const ch = codeOnly[argEnd];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) break;
    }
    const firstArg = src.slice(argStart, argEnd).trim();
    if (firstArg === '') continue; // Given() - not a registration
    const text = /^(['"`])[\s\S]*\1$/.test(firstArg) ? firstArg.slice(1, -1) : firstArg;

    // The implementation's body: the last `{...}` before the closing paren.
    const bodyClose = codeOnly.slice(0, close).search(/\}\s*,?\s*$/);
    const bodyOpen = bodyClose === -1 ? -1 : matchBackward(codeOnly, bodyClose, '{', '}');
    const stub =
      bodyOpen > argEnd &&
      noComments.slice(bodyOpen + 1, bodyClose).trim() === '' &&
      /TODO/i.test(src.slice(bodyOpen + 1, bodyClose));

    steps.push({
      keyword: m[1],
      text,
      normalized: normalize(src.slice(m.index, close + 1)),
      header: normalize(src.slice(m.index, bodyOpen > argEnd ? bodyOpen : close + 1)),
      stub,
    });
    lastEnd = close + 1;
  }
  return steps;
}

function byText(steps) {
  const map = new Map();
  for (const step of steps) {
    if (!map.has(step.text)) map.set(step.text, []);
    map.get(step.text).push(step);
  }
  return map;
}

/** The file's contents after the edit, or null when the tool call would fail anyway. */
function applyEdit(tool, toolInput, before) {
  if (tool === 'Write') return typeof toolInput.content === 'string' ? toolInput.content : null;
  const edits = tool === 'MultiEdit' ? toolInput.edits : [toolInput];
  if (!Array.isArray(edits) || before === null) return null;
  let text = before;
  for (const e of edits) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    if (!text.includes(e.old_string)) return null;
    text = e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.replace(e.old_string, () => e.new_string);
  }
  return text;
}

/** Step texts defined in the other steps/ files: text -> relative file name. */
function otherStepTexts(skipRel) {
  const found = new Map();
  const stepsDir = path.join(PROJECT_DIR, 'steps');
  let files = [];
  try {
    files = fs.readdirSync(stepsDir, { recursive: true });
  } catch {
    return found;
  }
  for (const f of files) {
    const rel = `steps/${String(f).split(path.sep).join('/')}`;
    if (!/\.js$/i.test(rel) || rel.toLowerCase() === skipRel.toLowerCase()) continue;
    try {
      for (const step of findSteps(fs.readFileSync(path.join(PROJECT_DIR, rel), 'utf-8'))) {
        if (!found.has(step.text)) found.set(step.text, rel);
      }
    } catch {
      // Unreadable or unparseable - it can't be compared, so skip it.
    }
  }
  return found;
}

runHook({
  name: 'check-step-edits',
  rule: '§4 (N6)',
  main(input, { deny, ask }) {
    if (!EDIT_TOOLS.has(input.tool_name)) return;
    const toolInput = input.tool_input || {};
    const rel = relToProject(toolInput.file_path, input.cwd);
    if (rel === null || !STEPS_FILE.test(rel)) return;

    const file = path.join(PROJECT_DIR, rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    const after = applyEdit(input.tool_name, toolInput, before);
    if (after === null) return;

    let oldSteps;
    let newSteps;
    try {
      oldSteps = before === null ? [] : findSteps(before);
      newSteps = findSteps(after);
    } catch (err) {
      ask(
        `CLAUDE.md §4 (N6): the step-edit guard couldn't parse ${rel} (${err.message}), so it ` +
          'cannot tell whether this change modifies an existing step definition. Approve only ' +
          'if it just adds new steps.',
        `${rel}: unparseable (${err.message})`,
      );
      return;
    }

    const oldByText = byText(oldSteps);
    const newByText = byText(newSteps);
    const problems = [];
    const stubs = [];

    for (const [text, olds] of oldByText) {
      const news = newByText.get(text) ?? [];
      if (news.length < olds.length) {
        problems.push(`removes or renames the existing step "${text}"`);
        continue;
      }
      if (news.length > olds.length) problems.push(`defines "${text}" a second time`);
      olds.forEach((old, i) => {
        if (old.normalized === news[i].normalized) return;
        if (old.stub && old.header === news[i].header) stubs.push(text);
        else if (old.stub)
          problems.push(`changes the text or parameters of the TODO stub "${text}"`);
        else problems.push(`modifies the existing step "${text}"`);
      });
    }

    const others = otherStepTexts(rel);
    for (const [text, news] of newByText) {
      if (oldByText.has(text)) continue;
      if (news.length > 1) problems.push(`defines the new step "${text}" ${news.length} times`);
      if (others.has(text)) {
        problems.push(`adds "${text}", which ${others.get(text)} already defines`);
      }
    }

    if (problems.length > 0) {
      deny(
        `Blocked by CLAUDE.md §4 (N6): this change to ${rel} ${problems.join('; ')}. Never ` +
          'modify existing step definitions - add a new step for what is missing, reuse an ' +
          'existing one verbatim, and report a step that looks broken to the user instead of ' +
          'changing it.',
        `${rel}: ${problems.join('; ')}`,
      );
    } else if (stubs.length > 0) {
      ask(
        `CLAUDE.md §4 (N6): this change fills in the TODO stub${stubs.length > 1 ? 's' : ''} ` +
          `${stubs.map(s => `"${s}"`).join(', ')} in ${rel}. §4 allows that only once you ` +
          'agree - approve only if you asked for it.',
        `${rel}: fills TODO stub ${stubs.join(', ')}`,
      );
    }
  },
});
