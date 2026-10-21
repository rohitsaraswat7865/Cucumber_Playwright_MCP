// Finds step registrations (Given/When/Then/Step) in a steps/**/*.js source.
// Shared by check-step-edits.cjs (N6) and check-todo-steps.cjs (§9) so the two
// agree on what a step and a `// TODO` stub are.
'use strict';

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

module.exports = { findSteps };
