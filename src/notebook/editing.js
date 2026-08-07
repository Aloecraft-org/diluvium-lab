// Text editing behaviours a code editor is expected to have.
//
// Kept apart from the highlighting and from completion, because it is the
// one part of the editor that has to be careful about *undo*. Assigning to
// `textarea.value` wipes the native undo stack -- one of those things that
// is invisible in a demo and infuriating five minutes into real use. Every
// edit here goes through `insertText`, which uses `execCommand` precisely
// because it is the only API that still participates in undo.

export const INDENT = '  ';

/**
 * Replace the current selection, preserving undo where the browser allows.
 *
 * `document.execCommand` is deprecated and has no replacement for this: the
 * standards track never produced a way to edit a textarea and keep its undo
 * stack. The fallback works and loses undo, which is the right way round.
 */
export function insertText(textarea, text) {
  textarea.focus();
  try {
    if (document.execCommand('insertText', false, text)) return;
  } catch {
    // some browsers throw rather than return false
  }
  const { selectionStart, selectionEnd, value } = textarea;
  textarea.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
  const caret = selectionStart + text.length;
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The offsets of the whole lines the selection touches. */
function lineSpan(value, start, end) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  let to = value.indexOf('\n', end);
  if (to === -1) to = value.length;
  return { from, to };
}

/**
 * Tab. Indents the selected lines, or inserts one indent at the caret.
 * @returns {boolean} whether it did anything
 */
export function indent(textarea) {
  const { selectionStart, selectionEnd, value } = textarea;

  if (selectionStart === selectionEnd) {
    insertText(textarea, INDENT);
    return true;
  }

  const { from, to } = lineSpan(value, selectionStart, selectionEnd);
  const block = value.slice(from, to);
  const shifted = block.split('\n').map((line) => INDENT + line).join('\n');

  textarea.setSelectionRange(from, to);
  insertText(textarea, shifted);
  // Keep the same lines selected, so Tab Tab Tab indents repeatedly.
  textarea.setSelectionRange(from, from + shifted.length);
  return true;
}

/** How much leading whitespace one Shift+Tab should remove. */
function dedentWidth(leading) {
  if (leading.startsWith('\t')) return 1;
  return Math.min(INDENT.length, (/^ */.exec(leading) ?? [''])[0].length);
}

/**
 * Shift+Tab. Removes one indent from the selected lines, or from the line
 * the caret is on.
 *
 * The line, not the text before the caret. An earlier version only looked
 * backwards from the caret, so `    <caret>end` dedented and
 * `<caret>    end` did not -- the same line, the same intent, two different
 * outcomes depending on where the caret happened to sit. Editors outdent
 * the line wherever the caret is in it, and so does this.
 */
export function dedent(textarea) {
  const { selectionStart, selectionEnd, value } = textarea;

  if (selectionStart === selectionEnd) {
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    let lineEnd = value.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = value.length;
    const leading = (/^[ \t]*/.exec(value.slice(lineStart, lineEnd)) ?? [''])[0];
    const remove = dedentWidth(leading);
    if (remove === 0) return false;

    textarea.setSelectionRange(lineStart, lineStart + remove);
    insertText(textarea, '');
    // Keep the caret on the same character it was on, unless that pushes
    // it before the start of the line.
    const caret = Math.max(lineStart, selectionStart - remove);
    textarea.setSelectionRange(caret, caret);
    return true;
  }

  const { from, to } = lineSpan(value, selectionStart, selectionEnd);
  const block = value.slice(from, to);
  const shifted = block.split('\n')
    .map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line.replace(/^ +/, '')))
    .join('\n');
  if (shifted === block) return false;

  textarea.setSelectionRange(from, to);
  insertText(textarea, shifted);
  textarea.setSelectionRange(from, from + shifted.length);
  return true;
}

export const LINE_COMMENT = '--';

/**
 * Ctrl+/ — comment the selected lines, or uncomment them if they already
 * are. One key that does both, decided by what is there: if every non-blank
 * line in the range is commented, the block is uncommented; otherwise it is
 * commented.
 *
 * The marker goes in at the *shallowest* indentation in the block rather
 * than at column zero, so commenting out the body of a loop leaves the
 * shape of the code visible instead of flattening it against the margin.
 */
export function toggleComment(textarea) {
  const { selectionStart, selectionEnd, value } = textarea;
  const { from, to } = lineSpan(value, selectionStart, selectionEnd);
  const lines = value.slice(from, to).split('\n');
  const meaningful = lines.filter((line) => line.trim() !== '');
  if (meaningful.length === 0) return false;

  const commented = meaningful.every((line) => /^\s*--/.test(line));
  const shifted = commented
    // `-- x` and `--x` both uncomment; only one space is eaten, so `---` and
    // a commented-out `--[[` survive intact.
    ? lines.map((line) => line.replace(/^(\s*)--[ ]?/, '$1'))
    : (() => {
      const column = Math.min(...meaningful.map((line) => (/^[ \t]*/.exec(line) ?? [''])[0].length));
      return lines.map((line) => (line.trim() === ''
        ? line
        : `${line.slice(0, column)}${LINE_COMMENT} ${line.slice(column)}`));
    })();

  const block = shifted.join('\n');
  const hadSelection = selectionStart !== selectionEnd;
  const firstLineDelta = shifted[0].length - lines[0].length;

  textarea.setSelectionRange(from, to);
  insertText(textarea, block);

  if (hadSelection) {
    textarea.setSelectionRange(from, from + block.length);
  } else {
    const caret = Math.max(from, selectionStart + firstLineDelta);
    textarea.setSelectionRange(caret, caret);
  }
  return true;
}

/**
 * Keep the new line's indentation when Enter is pressed, and add one more
 * after a line that opens a block. Small, and the difference between a text
 * box and something that feels like an editor.
 */
export function newlineAndIndent(textarea) {
  const { selectionStart, value } = textarea;
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const line = value.slice(lineStart, selectionStart);
  const leading = (/^[ \t]*/.exec(line) ?? [''])[0];
  const opensBlock = /(\b(then|do|else|repeat)|[({[]|\bfunction\b[^)]*\))\s*$/.test(line.trim());
  insertText(textarea, `\n${leading}${opensBlock ? INDENT : ''}`);
  return true;
}

/**
 * Wire Tab, Shift+Tab and Enter onto a textarea.
 *
 * Tab moves focus in a textarea by default, and taking that away is a real
 * accessibility cost -- a keyboard user can end up unable to leave the
 * field. The escape hatch is the conventional one: press Escape and the
 * *next* Tab moves focus as it always did.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {{isBusy?: () => boolean, handleEnter?: boolean}} options `isBusy`
 *   defers to whatever else is already handling the key -- an open
 *   completion popup, for instance. `handleEnter` is false for the console,
 *   where Enter submits rather than opening a line.
 */
export function attachEditing(textarea, options = {}) {
  const isBusy = options.isBusy ?? (() => false);
  const handleEnter = options.handleEnter ?? true;
  let tabEscapes = false;

  const onKeydown = (event) => {
    if (event.defaultPrevented || isBusy()) return;

    if (event.key === 'Escape') {
      tabEscapes = true;                 // next Tab leaves the field
      return;
    }

    // Ctrl+/ (Cmd+/ on a Mac). `code` as well as `key`, because on some
    // layouts the slash arrives only as a physical key.
    if ((event.ctrlKey || event.metaKey) && !event.altKey
        && (event.key === '/' || event.code === 'Slash')) {
      event.preventDefault();
      toggleComment(textarea);
      return;
    }

    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (tabEscapes) { tabEscapes = false; return; }   // let it move focus
      event.preventDefault();
      if (event.shiftKey) dedent(textarea); else indent(textarea);
      return;
    }

    // Ctrl/Cmd+Enter and Shift+Enter run the cell; they are not ours.
    if (handleEnter && event.key === 'Enter'
        && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      newlineAndIndent(textarea);
      return;
    }

    if (event.key.length === 1) tabEscapes = false;
  };

  textarea.addEventListener('keydown', onKeydown);
  return () => textarea.removeEventListener('keydown', onKeydown);
}
