// Syntax highlighting for Diluvium.
//
// Written here rather than vendored. CodeMirror is the obvious upgrade and
// remains so, but it is a real dependency that needs a real bundler, and
// what a notebook actually needs is colour -- not a code editor's folding,
// linting and multi-cursor. This is a scanner and a span emitter.
//
// The one invariant that matters: `highlightToHtml` must emit every
// character of the input, in order, unescaped-then-escaped and nothing
// else. The output is painted *underneath* a transparent textarea, so a
// single dropped or added character shifts every glyph after it out of
// alignment with the real caret. Tests assert the round trip.

import { escapeHtml } from './escape.js';

/**
 * Stock Lua 5.4's reserved words -- and, as it happens, exactly what
 * Diluvium 5.4.7 reserves. Used only as a fallback: the app asks the
 * running kernel for its own list, so switching to a build with more
 * keywords highlights that build's language rather than this one's.
 */
export const FALLBACK_KEYWORDS = [
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while',
];

/** Standard-library names, which read better in a different colour. */
export const FALLBACK_GLOBALS = [
  '_G', '_VERSION', 'assert', 'collectgarbage', 'coroutine', 'debug', 'dofile',
  'error', 'getmetatable', 'io', 'ipairs', 'load', 'loadfile', 'math', 'next',
  'os', 'package', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen',
  'rawset', 'require', 'select', 'setmetatable', 'string', 'table', 'tonumber',
  'tostring', 'type', 'utf8', 'warn', 'xpcall',
];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;

/**
 * @param {string} src
 * @returns {{type: string, start: number, end: number}[]} contiguous tokens
 *   covering `src` exactly, in order.
 */
export function tokenize(src, options = {}) {
  const keywords = new Set(options.keywords ?? FALLBACK_KEYWORDS);
  const globals = new Set(options.globals ?? FALLBACK_GLOBALS);
  const tokens = [];
  let i = 0;

  const push = (type, start, end) => {
    if (end > start) tokens.push({ type, start, end });
  };

  /** `[==[` ... `]==]`. Returns the index after the close, or src.length. */
  function scanLongBracket(at) {
    let j = at + 1;
    let level = 0;
    while (src[j] === '=') { level++; j++; }
    if (src[j] !== '[') return -1;
    j++;
    const close = `]${'='.repeat(level)}]`;
    const end = src.indexOf(close, j);
    return end === -1 ? src.length : end + close.length;
  }

  function scanShortString(at) {
    const quote = src[at];
    let j = at + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === quote) return j + 1;
      if (src[j] === '\n') return j;        // unterminated: stop at the line
      j++;
    }
    return src.length;
  }

  /**
   * Diluvium's interpolated string: `$"before {expr} after"`. The braces are
   * real code, so they get scanned as code -- highlighting them as string
   * would be a lie about what runs. `{{` is not an escape: the runtime reads
   * it as a table constructor inside the interpolation, so `{` always opens.
   */
  function scanFString(at) {
    const quote = src[at + 1];
    push('string-prefix', at, at + 2);
    let j = at + 2;
    let literal = j;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === quote) { push('string', literal, j + 1); return j + 1; }
      if (src[j] === '\n') { push('string', literal, j); return j; }
      if (src[j] === '{') {
        push('string', literal, j);
        const close = matchBrace(j);
        push('interp-brace', j, j + 1);
        for (const inner of tokenize(src.slice(j + 1, close), options)) {
          push(inner.type, j + 1 + inner.start, j + 1 + inner.end);
        }
        if (src[close] === '}') push('interp-brace', close, close + 1);
        j = src[close] === '}' ? close + 1 : close;
        literal = j;
        continue;
      }
      j++;
    }
    push('string', literal, src.length);
    return src.length;
  }

  /** Index of the `}` closing the `{` at `at`, or src.length. */
  function matchBrace(at) {
    let depth = 0;
    let j = at;
    while (j < src.length) {
      const c = src[j];
      if (c === '"' || c === "'") { j = scanShortString(j); continue; }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; if (depth === 0) return j - 1; continue; }
      j++;
    }
    return src.length;
  }

  function scanNumber(at) {
    let j = at;
    if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
      j += 2;
      while (j < src.length && (HEX.test(src[j]) || src[j] === '.')) j++;
      if (src[j] === 'p' || src[j] === 'P') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && DIGIT.test(src[j])) j++;
      }
      return j;
    }
    while (j < src.length && (DIGIT.test(src[j]) || src[j] === '.')) j++;
    if (src[j] === 'e' || src[j] === 'E') {
      j++;
      if (src[j] === '+' || src[j] === '-') j++;
      while (j < src.length && DIGIT.test(src[j])) j++;
    }
    return j;
  }

  while (i < src.length) {
    const c = src[i];

    // whitespace, kept as its own token so the output covers the input
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      push('space', i, j);
      i = j;
      continue;
    }

    // comments, long form first
    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '[') {
        const end = scanLongBracket(i + 2);
        if (end !== -1) { push('comment', i, end); i = end; continue; }
      }
      let j = src.indexOf('\n', i);
      if (j === -1) j = src.length;
      push('comment', i, j);
      i = j;
      continue;
    }

    if (c === '[') {
      const end = scanLongBracket(i);
      if (end !== -1) { push('string', i, end); i = end; continue; }
    }

    if (c === '$' && (src[i + 1] === '"' || src[i + 1] === "'")) {
      i = scanFString(i);
      continue;
    }

    if (c === '"' || c === "'") {
      const end = scanShortString(i);
      push('string', i, end);
      i = end;
      continue;
    }

    if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const end = scanNumber(i);
      push('number', i, end);
      i = end;
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i;
      while (j < src.length && IDENT_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      // `t.print` is a field, not the global print -- do not colour it as one
      const isField = /[.:]\s*$/.test(src.slice(Math.max(0, i - 2), i));
      let type = 'ident';
      if (keywords.has(word)) type = 'keyword';
      else if (!isField && globals.has(word)) type = 'builtin';
      else if (!isField && /^[A-Z][A-Z0-9_]*$/.test(word) && word.length > 1) type = 'constant';
      push(type, i, j);
      i = j;
      continue;
    }

    let j = i;
    while (j < src.length && /[-+*/%^#&~|<>=(){}\[\];:,.]/.test(src[j])) j++;
    push('operator', i, Math.max(j, i + 1));
    i = Math.max(j, i + 1);
  }

  return tokens;
}


/**
 * Render `src` as spans. Every character of `src` appears exactly once, in
 * order -- see the note at the top of this file about why that matters.
 */
export function highlightToHtml(src, options = {}) {
  let out = '';
  let at = 0;
  for (const token of tokenize(src, options)) {
    if (token.start > at) out += escapeHtml(src.slice(at, token.start));
    const text = escapeHtml(src.slice(token.start, token.end));
    out += token.type === 'space' ? text : `<span class="tok tok-${token.type}">${text}</span>`;
    at = token.end;
  }
  if (at < src.length) out += escapeHtml(src.slice(at));
  return out;
}

/** The text a highlight covers, for asserting the round trip. */
export function plainTextOf(src, options = {}) {
  let out = '';
  let at = 0;
  for (const token of tokenize(src, options)) {
    if (token.start > at) out += src.slice(at, token.start);
    out += src.slice(token.start, token.end);
    at = token.end;
  }
  return out + src.slice(at);
}
