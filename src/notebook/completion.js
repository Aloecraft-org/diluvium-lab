// Tab completion, driven by the kernel.
//
// The kernel has answered `complete_request` since Stage 1 and nothing ever
// asked it. This is the asking, and it matters more to a beginner than to
// anyone else: the standard library becomes discoverable by pressing a key
// rather than by already knowing what to search for.
//
// Not bound to Tab. Tab indents, which is what a code editor is expected to
// do, so completion is on **Ctrl+Space** and also opens by itself after a
// `.` or `:` on the end of a name. That second trigger is the one that
// teaches: typing `string.` and seeing the list is how someone finds
// `string.rep` without reading a reference first.

import { insertText } from './editing.js';

const MAX_VISIBLE = 12;

export class CompletionController {
  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {(code: string, cursor: number) => Promise<object>} complete
   */
  constructor(textarea, complete) {
    this.textarea = textarea;
    this.complete = complete;
    this.popup = null;
    this.matches = [];
    this.active = 0;
    this.span = null;

    // Capture, so an open popup gets Enter and Tab before anything that
    // would run the cell or indent it.
    textarea.addEventListener('keydown', (event) => this._onKeydown(event), true);
    textarea.addEventListener('input', (event) => this._onInput(event));
    textarea.addEventListener('blur', () => this.close());
  }

  get isOpen() { return this.popup !== null; }

  _onKeydown(event) {
    if (this.isOpen) {
      if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); this._move(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); this._move(-1); return; }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        this.accept();
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      this.close();     // any other key: the word moved on, the list is stale
      return;
    }

    if (event.code === 'Space' && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      this.request({ explicit: true });
    }
  }

  /** Open by itself after `name.` or `name:` -- the discovery case. */
  _onInput(event) {
    if (this.isOpen) return;
    if (event.inputType && event.inputType !== 'insertText') return;
    const before = this.textarea.value.slice(0, this.textarea.selectionStart);
    // Guard on an identifier before the dot, so `3.14` does not open a menu.
    if (/[A-Za-z0-9_\])][.:]$/.test(before)) this.request();
  }

  /**
   * @param {{explicit?: boolean}} options Only an explicit request (Ctrl+Space)
   *   is allowed to *change* the text. The `.` trigger fires while someone is
   *   still typing, and the kernel round trip can land between two
   *   keystrokes -- inserting there raced the typist and produced
   *   `inventory.apap`. Auto-open shows; it never edits.
   */
  async request({ explicit = false } = {}) {
    const cursor = this.textarea.selectionStart;
    let reply;
    try {
      reply = await this.complete(this.textarea.value, cursor);
    } catch {
      return;                             // completion is never worth failing over
    }
    const matches = reply?.matches ?? [];
    if (matches.length === 0) return;
    // The caret moved while the kernel was answering.
    if (this.textarea.selectionStart !== cursor) return;

    this.span = { start: reply.cursor_start, end: reply.cursor_end };

    const typed = this.textarea.value.slice(this.span.start, this.span.end);
    const shared = commonPrefix(matches);
    if (explicit && matches.length === 1) { this._insert(matches[0]); return; }
    if (explicit && shared.length > typed.length) {
      // Fill in as far as every match agrees, the way a shell does.
      this._insert(shared, { keepOpen: true });
      this.span = { start: this.span.start, end: this.span.start + shared.length };
    }

    this.matches = matches;
    this.active = 0;
    this._open();
  }

  _insert(text, { keepOpen = false } = {}) {
    this.textarea.setSelectionRange(this.span.start, this.span.end);
    insertText(this.textarea, text);      // via execCommand, so undo still works
    if (!keepOpen) this.close();
  }

  accept() {
    const chosen = this.matches[this.active];
    if (chosen !== undefined) this._insert(chosen);
    this.close();
  }

  _move(delta) {
    this.active = (this.active + delta + this.matches.length) % this.matches.length;
    this._render();
  }

  _open() {
    // Remove the node only. Calling close() here would clear `matches`
    // first and render an empty menu -- which is exactly what it did.
    this._removePopup();
    this.popup = document.createElement('ul');
    this.popup.className = 'completions';
    this.popup.setAttribute('role', 'listbox');
    this.popup.dataset.completions = 'true';

    const wrap = this.textarea.closest('.editor-wrap') ?? this.textarea.parentElement;
    wrap.appendChild(this.popup);
    this._render();
  }

  _render() {
    if (!this.popup) return;
    this.popup.replaceChildren(...this.matches.slice(0, MAX_VISIBLE).map((match, i) => {
      const item = document.createElement('li');
      item.textContent = match;
      item.setAttribute('role', 'option');
      item.dataset.completion = match;
      if (i === this.active) {
        item.dataset.active = 'true';
        item.setAttribute('aria-selected', 'true');
      }
      // mousedown, not click: a click arrives after blur has closed this.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.active = i;
        this.accept();
      });
      return item;
    }));

    if (this.matches.length > MAX_VISIBLE) {
      const more = document.createElement('li');
      more.className = 'completions-more';
      more.textContent = `… and ${this.matches.length - MAX_VISIBLE} more`;
      this.popup.appendChild(more);
    }
  }

  _removePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  close() {
    this._removePopup();
    this.matches = [];
  }
}

export function commonPrefix(words) {
  if (words.length === 0) return '';
  let prefix = words[0];
  for (const word of words.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < word.length && prefix[i] === word[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === '') break;
  }
  return prefix;
}
