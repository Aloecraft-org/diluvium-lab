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
//
// What it colours is not fixed. The 5.5 language work adds forms a given
// build either has or does not -- regex literals landed in build13, the
// pin here is build10, and the runtime dropdown can point the page at
// either. So every form past stock Lua sits behind a name in
// `options.syntax`, and `app.js` fills that set from snippets the
// *running kernel* was asked to compile. This is the discipline the
// keyword list already follows, for the same reason: a Lab pointed at a
// build without backtick literals leaves a backtick an operator, because
// there it is one. The default is the empty set, so a form draws nothing
// until a build has been observed to parse it.

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

/**
 * The forms this tokenizer can be asked to recognise, past stock Lua.
 *
 * A name here is a name `SYNTAX_CANDIDATES` in `kernel/lua-harness.js`
 * probes for; the two lists are checked against each other by a test,
 * because a typo in either would be a form that can never light up and
 * nothing would say so.
 *
 *   regex        `` `\d+` ``            a compiled regular expression
 *   separators   `1_000_000`            underscores between digits
 *   binary       `0b1010`               base-two integer literals
 *   suffix       `0.05d`                the literal-suffix registry
 *   optional     `a?.b`, `a ?? b`       safe navigation and coalescing
 *   optional-call `a?:m()`, `a?(1)`     the call half of that family
 *   compound     `n += 1`, `s ..= "x"`  compound assignment
 *   secure       `~function f() end`    the obfuscating function prefix
 *   spread       `f(...args)`           spread, as against vararg `...`
 *   lambda       `|x| x * 2`            compact lambdas
 *   attribute    `function f() <pure>`  function attributes
 *   at-self      `@balance`, `@:m()`    `self` sugar inside a class
 */
export const SYNTAX_FORMS = [
  'regex', 'separators', 'binary', 'suffix',
  'optional', 'optional-call', 'compound', 'secure',
  'spread', 'lambda', 'attribute', 'at-self',
];

/** Nothing beyond stock Lua, until a build says otherwise. */
export const FALLBACK_SYNTAX = [];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const HEX = /[0-9a-fA-F]/;

/** Compound assignment, longest first: `//=` is not `/` then `/=`. */
const COMPOUND = /^(?:\/\/|<<|>>|\.\.|[+\-*/%^|&])=/;

/**
 * A lambda's parameter list: `|x|`, `|a, b|`, or `||` for none.
 *
 * Requiring the whole shape is what makes this safe. `a | b` has an
 * identifier after the bar and no closing bar, so it never matches, and
 * the previous-token test below only has to rule out the rest.
 */
const LAMBDA_PARAMS = /^\|\s*(?:[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*)?\|/;

/** A function attribute: `<deterministic>`, and Lua's own `<const>` shape. */
const ATTRIBUTE = /^<[A-Za-z_]\w*>/;

/** Tokens that can end an expression, so a `|` after one is bitwise or. */
const ENDS_EXPRESSION = new Set(['ident', 'number', 'string', 'regex', 'constant', 'builtin']);
const ENDS_EXPRESSION_KEYWORDS = new Set(['end', 'true', 'false', 'nil']);

/**
 * @param {string} src
 * @param {{keywords?: string[], globals?: string[], syntax?: string[]}} options
 * @returns {{type: string, start: number, end: number}[]} contiguous tokens
 *   covering `src` exactly, in order.
 */
export function tokenize(src, options = {}) {
  const keywords = new Set(options.keywords ?? FALLBACK_KEYWORDS);
  const globals = new Set(options.globals ?? FALLBACK_GLOBALS);
  const syntax = new Set(options.syntax ?? FALLBACK_SYNTAX);
  const separators = syntax.has('separators');
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
   * A regex literal. The text is **raw** -- there are no string escapes
   * inside one, which is the reason the notation exists -- so the only
   * thing that ends it is an odd backtick. A doubled backtick is one
   * backtick of pattern and does not close.
   *
   * A newline ends it. That is an error in the compiler, and stopping
   * here rather than running on is what keeps an unfinished literal from
   * painting the rest of the file as a pattern.
   */
  function scanRegex(at) {
    let j = at + 1;
    while (j < src.length) {
      if (src[j] === '\n') return j;
      if (src[j] === '`') {
        if (src[j + 1] === '`') { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return src.length;
  }

  /**
   * Diluvium's interpolated string: `$"before {expr} after"`. The braces are
   * real code, so they get scanned as code -- highlighting them as string
   * would be a lie about what runs. `{{` is not an escape: the runtime reads
   * it as a table constructor inside the interpolation, so `{` always opens.
   *
   * `{expr::spec}` hands everything after the `::` to `string.format`, so
   * that tail is a format spec and not more code. `%-10s` tokenized as Lua
   * is an operator, a number and an identifier, none of which it is.
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
        const spec = specStart(j + 1, close);
        for (const inner of tokenize(src.slice(j + 1, spec), options)) {
          push(inner.type, j + 1 + inner.start, j + 1 + inner.end);
        }
        push('format-spec', spec, close);
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
      if (c === '`' && syntax.has('regex')) { j = scanRegex(j); continue; }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; if (depth === 0) return j - 1; continue; }
      j++;
    }
    return src.length;
  }

  /**
   * Where the format spec of an interpolation starts, or `end` if there
   * is none. The `::` that splits it is the first one at the top level:
   * a single `:` is a method call and stays code, and a `::` inside a
   * string or a regex belongs to that literal.
   */
  function specStart(from, end) {
    let j = from;
    while (j < end) {
      const c = src[j];
      if (c === '"' || c === "'") { j = Math.min(scanShortString(j), end); continue; }
      if (c === '`' && syntax.has('regex')) { j = Math.min(scanRegex(j), end); continue; }
      if (c === ':' && src[j + 1] === ':' && j + 1 < end) return j;
      j++;
    }
    return end;
  }

  /**
   * A run of digits `test` accepts, with `_` between them where the build
   * takes separators. The underscore has to sit *between* two digits, so
   * `1_000` is one number and `x = 1` followed by `_G` stays two tokens.
   */
  function scanRun(from, test) {
    let j = from;
    while (j < src.length) {
      if (test(src[j])) { j++; continue; }
      if (separators && src[j] === '_' && test(src[j + 1] ?? '')) { j += 2; continue; }
      break;
    }
    return j;
  }

  function scanNumber(at) {
    let j = at;
    if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
      j = scanRun(j + 2, (ch) => HEX.test(ch) || ch === '.');
      if (src[j] === 'p' || src[j] === 'P') {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        j = scanRun(j, (ch) => DIGIT.test(ch));
      }
      return j;
    }
    if (syntax.has('binary') && src[j] === '0' && (src[j + 1] === 'b' || src[j + 1] === 'B')) {
      return scanRun(j + 2, (ch) => ch === '0' || ch === '1');
    }
    j = scanRun(j, (ch) => DIGIT.test(ch) || ch === '.');
    if (src[j] === 'e' || src[j] === 'E') {
      j++;
      if (src[j] === '+' || src[j] === '-') j++;
      j = scanRun(j, (ch) => DIGIT.test(ch));
    }
    // A literal suffix -- `0.05d` -- is part of the numeral, and looking
    // it up is the registry's job rather than the lexer's, so any run of
    // letters counts. Lua's own lexer eats them too, and then fails; the
    // difference is only what happens after.
    if (syntax.has('suffix') && IDENT_START.test(src[j] ?? '')) {
      while (j < src.length && IDENT_PART.test(src[j])) j++;
    }
    return j;
  }

  /** Whether a spread -- `...` then a name -- begins at `at`. */
  function spreadAt(at) {
    return syntax.has('spread')
      && src.startsWith('...', at) && IDENT_START.test(src[at + 3] ?? '');
  }

  /** The last token that is not whitespace, or null at the start. */
  function lastMeaningful() {
    for (let k = tokens.length - 1; k >= 0; k--) {
      if (tokens[k].type !== 'space') return tokens[k];
    }
    return null;
  }

  /**
   * Whether an expression could begin here. `|` opens a lambda only in
   * that position; everywhere else it is bitwise or, and the two are told
   * apart by what came before exactly as a regex literal is in other
   * languages.
   */
  function atExpressionStart() {
    const prev = lastMeaningful();
    if (!prev) return true;
    if (ENDS_EXPRESSION.has(prev.type)) return false;
    if (prev.type === 'keyword') return !ENDS_EXPRESSION_KEYWORDS.has(src.slice(prev.start, prev.end));
    if (prev.type === 'operator') {
      const last = src[prev.end - 1];
      return !(last === ')' || last === ']' || last === '}');
    }
    return true;
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

    if (c === '`' && syntax.has('regex')) {
      const end = scanRegex(i);
      push('regex', i, end);
      i = end;
      continue;
    }

    if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const end = scanNumber(i);
      push('number', i, end);
      i = end;
      continue;
    }

    // `~function` marks a function whose constants are obfuscated. The
    // same `~` is bitwise-not everywhere else, so only this one position
    // reads as a modifier.
    if (c === '~' && syntax.has('secure') && /^\s*function\b/.test(src.slice(i + 1, i + 12))) {
      push('secure', i, i + 1);
      i += 1;
      continue;
    }

    // `??`, `??=`, `?.` and `?[`. Not in the operator run below, because
    // `?` is not an operator character in any build that lacks them.
    //
    // `?:` and `?(` are the same family and a separate flag, because the
    // shipped build has the first four and not these two: colouring
    // `a?:m()` here would be colouring a syntax error.
    if (c === '?') {
      const len = (syntax.has('optional') && src.startsWith('??=', i)) ? 3
        : (syntax.has('optional')
          && (src.startsWith('??', i) || src.startsWith('?.', i) || src.startsWith('?[', i))) ? 2
          : (syntax.has('optional-call')
            && (src.startsWith('?:', i) || src.startsWith('?(', i))) ? 2
            : 0;
      if (len) { push('null-safe', i, i + len); i += len; continue; }
    }

    // `...args` spreads; a bare `...` is the vararg it has always been.
    if (c === '.' && spreadAt(i)) {
      push('spread', i, i + 3);
      i += 3;
      continue;
    }

    // `@balance` is `self.balance`, and `@:m()` is `self:m()`. The name
    // stays an identifier -- it is a field, and reads as one.
    if (c === '@' && syntax.has('at-self') && /[A-Za-z_:]/.test(src[i + 1] ?? '')) {
      push('self-sugar', i, i + 1);
      i += 1;
      continue;
    }

    // `function f(x) <deterministic>`. The attribute only follows a `)`,
    // which is the position the freeness argument rests on, and is also
    // what keeps `f(x) < b > c` from being read as one.
    if (c === '<' && syntax.has('attribute')) {
      const prev = lastMeaningful();
      const afterCall = prev?.type === 'operator' && src[prev.end - 1] === ')';
      const match = afterCall ? ATTRIBUTE.exec(src.slice(i)) : null;
      if (match) { push('attribute', i, i + match[0].length); i += match[0].length; continue; }
    }

    // `|x| x * 2`. Both bars are the lambda's; the parameters between
    // them are ordinary identifiers.
    if (c === '|' && syntax.has('lambda') && atExpressionStart()) {
      const match = LAMBDA_PARAMS.exec(src.slice(i));
      if (match) {
        const close = i + match[0].length - 1;
        push('lambda-bar', i, i + 1);
        for (const inner of tokenize(src.slice(i + 1, close), options)) {
          push(inner.type, i + 1 + inner.start, i + 1 + inner.end);
        }
        push('lambda-bar', close, close + 1);
        i = close + 1;
        continue;
      }
    }

    if (syntax.has('compound')) {
      const match = COMPOUND.exec(src.slice(i, i + 3));
      if (match) { push('compound-assign', i, i + match[0].length); i += match[0].length; continue; }
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
    while (j < src.length && /[-+*/%^#&~|<>=(){}\[\];:,.]/.test(src[j])) {
      // `{...defaults}` opens a constructor and then spreads. Without
      // this the run swallows `{...` whole and the spread never gets
      // its own case above.
      if (j > i && spreadAt(j)) break;
      j++;
    }
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
