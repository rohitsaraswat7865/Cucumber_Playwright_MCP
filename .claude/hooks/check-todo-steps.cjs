// Prompt-time half of CLAUDE.md §9. Runs as a UserPromptSubmit hook, so on
// EVERY user prompt (not just the first of a session) it scans steps/**/*.js
// for `// TODO`-only step bodies:
//
//   - none found   -> nothing happens
//   - some found   -> the session's start-menu marker is cleared, so
//                     check-session-menu.cjs blocks every tool until the menu
//                     has been shown again, and the stub list is added to the
//                     prompt's context
//
// Same stub definition as check-step-edits.cjs (step-parser.cjs). Fails closed:
// if the scan can't run, the prompt is blocked and the reason says why.
'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_DIR, MENU_MARKER_DIR: MARKER_DIR, audit } = require('./hook-utils.cjs');
const { findSteps } = require('./step-parser.cjs');

const emit = out => process.stdout.write(JSON.stringify(out));

function todoStubs() {
  const found = [];
  const stepsDir = path.join(PROJECT_DIR, 'steps');
  let files;
  try {
    files = fs.readdirSync(stepsDir, { recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return found;
    throw err;
  }
  for (const f of files) {
    const rel = `steps/${String(f).split(path.sep).join('/')}`;
    if (!/\.js$/i.test(rel)) continue;
    let steps;
    try {
      steps = findSteps(fs.readFileSync(path.join(PROJECT_DIR, rel), 'utf-8'));
    } catch (err) {
      throw new Error(`could not parse ${rel}: ${err.message}`, { cause: err });
    }
    for (const step of steps) if (step.stub) found.push({ file: rel, text: step.text });
  }
  return found;
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  const id = typeof input.session_id === 'string' ? input.session_id : '';
  if (!/^[\w-]{1,128}$/.test(id)) {
    throw new Error(`hook input has no usable session_id (${JSON.stringify(id)})`);
  }

  const stubs = todoStubs();
  audit({
    hook: 'check-todo-steps',
    tool: 'UserPromptSubmit',
    rule: '§9',
    decision: 'allow',
    detail: `${stubs.length} TODO stub(s)`,
  });
  if (stubs.length > 0) {
    fs.rmSync(path.join(MARKER_DIR, id), { force: true });
    emit({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          `CLAUDE.md §9: ${stubs.length} TODO-only step${stubs.length > 1 ? 's are' : ' is'} ` +
          `present in steps/: ${stubs.map(s => `"${s.text}" (${s.file})`).join('; ')}. ` +
          'Before any other tool call, call AskUserQuestion with the §9 start menu.',
      },
    });
  }
} catch (err) {
  audit({
    hook: 'check-todo-steps',
    tool: 'UserPromptSubmit',
    rule: '§9',
    decision: 'block',
    detail: err.message,
  });
  emit({
    decision: 'block',
    reason:
      `Blocked by CLAUDE.md §9: the TODO-step check failed (${err.message}), so the prompt ` +
      'is blocked rather than let through unchecked. The hook needs fixing.',
  });
}
