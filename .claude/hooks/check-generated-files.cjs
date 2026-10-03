// Mechanical enforcement of CLAUDE.md N4 / §1 (never hand-edit a generated file)
// and of the §1 ⚠️ harness rows. Runs as a PreToolUse hook on Claude's
// file-editing tools:
//
//   - a ❌ generated path (rewritten by global setup, bddgen, the test run, the
//     MCP server or npm, so a hand-edit is either silently discarded or - for
//     .auth/ - silently breaks the session), at any depth -> deny
//   - the harness (.claude/settings*.json, .claude/hooks/, session-state.js,
//     .mcp.json), which Claude may change only when asked -> ask
//
// The path rules live in hook-utils.cjs, shared with check-shell-writes.cjs,
// which covers the same paths for shell commands. Fails closed (hook-utils.cjs).
'use strict';

const { runHook, relToProject, classifyPath } = require('./hook-utils.cjs');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

runHook({
  name: 'check-generated-files',
  rule: '§1 (N4)',
  main(input, { deny, ask }) {
    if (!EDIT_TOOLS.has(input.tool_name)) return;

    const toolInput = input.tool_input || {};
    const rel = relToProject(toolInput.file_path || toolInput.notebook_path, input.cwd);
    const hit = rel === null ? null : classifyPath(rel);
    if (!hit) return;

    if (hit.kind === 'generated') {
      deny(
        `Blocked by CLAUDE.md §1 (N4): ${rel} is generated output - never hand-edit it. ${hit.why}.`,
        rel,
      );
    } else {
      ask(
        `CLAUDE.md §1: ${rel} is part of the harness (${hit.why}). Claude may change the ` +
          'harness only when you explicitly asked for that change - approve only if you did.',
        rel,
      );
    }
  },
});
