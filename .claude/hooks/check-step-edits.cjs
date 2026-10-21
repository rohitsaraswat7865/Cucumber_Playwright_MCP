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
const { findSteps } = require('./step-parser.cjs');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const STEPS_FILE = /^steps\/(.+\/)?[^/]+\.js$/i;

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
  let files;
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
