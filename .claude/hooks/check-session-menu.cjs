// Mechanical enforcement of CLAUDE.md N7 / §9 (open every session with the
// start menu). Runs as a PreToolUse hook on every tool:
//
//   - the session has already shown the menu                -> allowed
//   - AskUserQuestion asking the §9 menu question with both
//     §9 options                                            -> allowed, and the
//                                                              session is marked
//   - anything else before that                             -> deny
//
// The marker is one empty file per session id under the OS temp dir, outside
// the project, so it never lands in a generated or tracked path. A resumed or
// compacted session keeps its id and so stays unlocked. check-todo-steps.cjs
// clears it on any prompt while TODO steps exist, so the menu is asked again.
// Markers older than MARKER_MAX_AGE_DAYS are pruned whenever a new one is written.
//
// A first turn that answers in plain text with no tool call isn't caught.
// Fails closed (hook-utils.cjs).
'use strict';

const fs = require('fs');
const path = require('path');
const { runHook, MENU_MARKER_DIR: MARKER_DIR } = require('./hook-utils.cjs');

// Keep in step with CLAUDE.md §9.
const MENU_QUESTION = 'What would you like to do?';
const MENU_OPTIONS = ['Implement TODO steps', 'Exit'];
const MARKER_MAX_AGE_DAYS = 7;

/** Deletes markers of sessions untouched for a week. Best-effort, never throws. */
function pruneOldMarkers() {
  const cutoff = Date.now() - MARKER_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let names;
  try {
    names = fs.readdirSync(MARKER_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(MARKER_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

const isMenu = toolInput => {
  const questions = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  if (questions.length !== 1) return false;
  const q = questions[0] || {};
  const labels = Array.isArray(q.options) ? q.options.map(o => o && o.label) : [];
  return (
    typeof q.question === 'string' &&
    q.question.trim() === MENU_QUESTION &&
    labels.length === MENU_OPTIONS.length &&
    MENU_OPTIONS.every(l => labels.includes(l))
  );
};

runHook({
  name: 'check-session-menu',
  rule: '§9 (N7)',
  main(input, { deny }) {
    const id = typeof input.session_id === 'string' ? input.session_id : '';
    if (!/^[\w-]{1,128}$/.test(id)) {
      throw new Error(`hook input has no usable session_id (${JSON.stringify(id)})`);
    }
    const marker = path.join(MARKER_DIR, id);
    if (fs.existsSync(marker)) return;

    if (input.tool_name === 'AskUserQuestion' && isMenu(input.tool_input)) {
      fs.mkdirSync(MARKER_DIR, { recursive: true });
      fs.writeFileSync(marker, '');
      pruneOldMarkers();
      return;
    }

    deny(
      `Blocked by CLAUDE.md §9 (N7): this session hasn't shown the start menu yet. Before any ` +
        `other tool, call AskUserQuestion once with the single question "${MENU_QUESTION}" and ` +
        `exactly the options ${MENU_OPTIONS.map(l => `"${l}"`).join(' and ')}, then act on the answer.`,
      `menu not shown yet: ${input.tool_name}`,
    );
  },
});
