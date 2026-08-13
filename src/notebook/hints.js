// Plain-English hints for the errors people actually hit.
//
// Lua's messages are accurate and terse, which is a fine trade for someone
// who already knows Lua and a bad one for someone on their first afternoon.
// `attempt to perform arithmetic on a nil value (global 'total')` contains
// everything you need and explains nothing.
//
// This is presentation, not kernel: it never changes what ran or what the
// runtime said. The original message is always shown, above the hint, and
// the hint is additive. A wrong guess costs a confusing extra sentence; a
// missing guess costs nothing. Both are better than rewriting the error.
//
// Rules are ordered, first match wins, and each explains *why* rather than
// restating the message with different words.

const RULES = [
  // --- things that are nil ------------------------------------------
  {
    match: /attempt to index a nil value \((?:global|local) '([^']+)'\)/,
    hint: (n) => `\`${n}\` has no value yet, so there is nothing to look inside. `
      + `Check the spelling, or make sure the cell that defines it has been run.`,
  },
  {
    match: /attempt to index a nil value \(field '([^']+)'\)/,
    hint: (n) => `The field \`${n}\` is missing from that table, so \`.${n}\` gave back nothing `
      + `and the next \`.\` had nothing to work with.`,
  },
  {
    match: /attempt to index a nil value/,
    hint: () => 'Something in that chain of `.` or `[]` is nil. Try printing the parts one at a time.',
  },
  {
    match: /attempt to call a nil value \((?:global|local) '([^']+)'\)/,
    hint: (n) => `There is no function called \`${n}\`. Either it is spelled differently, `
      + `or the cell that defines it has not been run yet.`,
  },
  {
    match: /attempt to call a nil value \(method '([^']+)'\)/,
    hint: (n) => `That value has no method \`${n}\`. Note \`:\` and \`.\` differ — \`obj:${n}()\` `
      + `passes \`obj\` as the first argument, \`obj.${n}()\` does not.`,
  },
  {
    match: /attempt to perform arithmetic on a nil value \((?:global|local|field) '([^']+)'\)/,
    hint: (n) => `\`${n}\` is nil, and nil is not a number. If it is a counter, give it a `
      + `starting value first: \`${n} = (${n} or 0) + 1\`.`,
  },
  {
    match: /attempt to perform arithmetic on a (\w+) value/,
    hint: (kind) => `You can only do maths on numbers, and that value is a ${kind}. `
      + `\`tonumber(x)\` converts a string like "42" into a number.`,
  },
  {
    match: /attempt to concatenate a nil value \((?:global|local|field) '([^']+)'\)/,
    hint: (n) => `\`..\` joins strings, and \`${n}\` is nil. \`tostring(${n})\` makes it printable, `
      + `or use \`$"...{${n}}..."\` which handles that for you.`,
  },
  {
    match: /attempt to concatenate a (\w+) value/,
    hint: (kind) => `\`..\` joins strings and numbers only, not a ${kind}. `
      + 'Wrap it in `tostring(...)` first.',
  },
  {
    match: /attempt to compare (\w+) with (\w+)/,
    hint: (a, b) => `A ${a} and a ${b} cannot be ordered against each other. `
      + 'If one should be a number, convert it with `tonumber(...)` first.',
  },
  { match: /table index is nil/, hint: () => 'A table key cannot be nil. The expression inside the `[ ]` came out as nothing.' },
  { match: /table index is NaN/, hint: () => 'A table key cannot be NaN — usually the result of `0/0` or a failed conversion.' },

  // --- arguments ----------------------------------------------------
  {
    match: /bad argument #(\d+) to '([^']+)' \((\w+) expected, got no value\)/,
    hint: (i, fn, want) => `\`${fn}\` needs a ${want} as argument ${i}, and nothing was passed. `
      + 'An argument is probably missing.',
  },
  {
    match: /bad argument #(\d+) to '([^']+)' \((\w+) expected, got (\w+)\)/,
    hint: (i, fn, want, got) => `Argument ${i} of \`${fn}\` should be a ${want}, but a ${got} arrived.`,
  },

  // --- syntax -------------------------------------------------------
  {
    match: /'end' expected .*near <eof>/,
    hint: () => 'A block was opened and never closed. Every `function`, `if`, `for` and `while` '
      + 'needs a matching `end`.',
  },
  {
    match: /'end' expected \(to close '(\w+)' at line (\d+)\)/,
    hint: (what, line) => `The \`${what}\` on line ${line} is still open. It needs its own \`end\`.`,
  },
  {
    match: /'([)\]}])' expected/,
    hint: (ch) => `A \`${ch}\` is missing — something opened earlier was never closed.`,
  },
  {
    // What `if x = 1 then` actually produces is "'then' expected near '='",
    // because the parser gives up at the `=` rather than at the symbol.
    match: /'[^']+' expected near '='/,
    hint: () => 'Lua uses `=` to assign and `==` to compare. Inside an `if` or a `while`, '
      + 'you almost certainly want `==`.',
  },
  {
    match: /unexpected symbol near '='/,
    hint: () => 'Lua uses `=` to assign and `==` to compare. Inside an `if`, you almost certainly want `==`.',
  },
  {
    match: /unexpected symbol near <eof>/,
    hint: () => 'The cell ends in the middle of something. An expression or a bracket is unfinished.',
  },
  {
    match: /unfinished string/,
    hint: () => 'A string was opened and never closed. Quotes have to match, and a plain '
      + '`"..."` string cannot span lines — use `[[...]]` for that.',
  },
  { match: /malformed number near '([^']+)'/, hint: (n) => `\`${n}\` is not a number Lua can read.` },
  {
    match: /syntax error near '([^']+)'/,
    hint: (tok) => `Lua got as far as \`${tok}\` and could not make sense of it. `
      + 'A missing operator, comma or keyword just before it is the usual cause.',
  },

  // --- runaway ------------------------------------------------------
  {
    match: /stack overflow/,
    hint: () => 'A function is calling itself without ever stopping. A recursive function needs '
      + 'a case that returns without recursing.',
  },
  { match: /too many results/, hint: () => 'Far more values were returned than Lua can hold at once.' },
  {
    match: /not enough memory/,
    hint: () => 'The kernel ran out of memory — usually a table or string growing without bound in a loop.',
  },
];

/**
 * A hint for an error message, or null when nothing useful can be said.
 * @param {string} message the runtime's own text
 * @returns {string|null}
 */
export function hintFor(message) {
  if (typeof message !== 'string') return null;
  for (const rule of RULES) {
    const found = rule.match.exec(message);
    if (found) return rule.hint(...found.slice(1));
  }
  return null;
}

/**
 * A nudge for output that is technically correct and useless to read.
 *
 * `print(t)` writes `table: 0x1f2e0`, because that is what Lua's print
 * does and the notebook does not redefine it. The echo *does* render
 * tables, so the fix is one the reader can act on immediately.
 */
export function tipForOutput(text) {
  if (typeof text === 'string' && /\btable: 0x[0-9a-f]+/.test(text)) {
    return 'Tip: put the table on a line by itself, with no `print`, to see what is inside it.';
  }
  return null;
}

/** Rendered by the UI; exported for tests and for a future docs page. */
export const HINT_RULE_COUNT = RULES.length;

/**
 * Hint text carries `code spans`. Built as nodes rather than assigned as
 * HTML: hints are our own strings today, but the rule in this codebase is
 * that nothing reaches the DOM as markup, so there is no version of this
 * that can be got wrong later. Lives beside the hints because everything
 * that shows one -- cells and console alike -- needs it.
 */
export function withCodeSpans(text) {
  return String(text).split(/`([^`]+)`/).map((piece, i) => (
    i % 2 === 1 ? Object.assign(document.createElement('code'), { textContent: piece }) : piece
  )).filter((piece) => piece !== '');
}
