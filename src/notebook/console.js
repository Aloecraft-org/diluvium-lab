// The console pane: scratch execution against the same kernel.
//
// It shares the kernel with the notebook rather than getting one of its own,
// which is the entire point -- poke at a variable the notebook just defined
// without adding a cell you then have to delete.

import { el } from './dom.js';
import { outputText } from './ipynb.js';
import { HighlightedEditor } from './editor.js';
import { hintFor, withCodeSpans } from './hints.js';
import { MSG } from '../kernel/protocol.js';

export class ConsoleView {
  /**
   * @param {HTMLElement} root
   * @param {{onExecute: (code: string) => Promise<object[]>,
   *          onIsComplete: (code: string) => Promise<string>}} handlers
   */
  constructor(root, handlers) {
    this.root = root;
    this.handlers = handlers;
    this.log = root.querySelector('[data-console-log]');
    this.input = root.querySelector('[data-console-input]');
    this.history = [];
    this.historyAt = 0;
    // What was being typed when history was first recalled -- restored
    // when ArrowDown walks past the newest entry, the way readline keeps
    // a draft at the end of the walk instead of eating it.
    this.draft = null;
    this.busy = false;

    this.editor = new HighlightedEditor(this.input, handlers.languageInfo ?? (() => ({})), {
      complete: handlers.complete,
      handleEnter: false,          // Enter submits here; it is not a newline
    });

    this.input.addEventListener('keydown', (event) => this._onKeydown(event));
    this.input.addEventListener('input', () => {
      this.input.rows = Math.max(1, this.input.value.split('\n').length);
    });
  }

  /** Keep the input's colours in step after a kernel swap. */
  repaintHighlight() { this.editor.paint(); }

  /**
   * Setting `.value` fires no `input` event, so the highlight underneath
   * would keep showing the previous text. Every programmatic write goes
   * through here.
   */
  _setInput(value) {
    this.input.value = value;
    this.input.rows = Math.max(1, value.split('\n').length);
    this.editor.paint();
  }

  async _onKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      await this.submit();
      return;
    }
    // History from the first and last *lines*, so arrows still navigate
    // the middle of a multi-line draft. The old caret==0 rule cost two
    // presses per step, because recalling put the caret at the end.
    const before = this.input.value.slice(0, this.input.selectionStart);
    const after = this.input.value.slice(this.input.selectionEnd);
    if (event.key === 'ArrowUp' && !before.includes('\n') && this.history.length) {
      event.preventDefault();
      if (this.historyAt >= this.history.length) this.draft = this.input.value;
      this.historyAt = Math.max(0, this.historyAt - 1);
      this._setInput(this.history[this.historyAt] ?? '');
      return;
    }
    if (event.key === 'ArrowDown' && !after.includes('\n')) {
      if (this.historyAt >= this.history.length) return;
      event.preventDefault();
      this.historyAt = Math.min(this.history.length, this.historyAt + 1);
      // Walking past the newest entry lands back on whatever was being
      // typed before the walk began.
      this._setInput(this.historyAt >= this.history.length
        ? (this.draft ?? '')
        : (this.history[this.historyAt] ?? ''));
    }
  }

  /**
   * Run what is in the box, unless Lua says it is unfinished -- in which
   * case take a newline instead, the way every REPL does.
   */
  async submit() {
    if (this.busy) return;
    const code = this.input.value;
    if (code.trim() === '') return;

    // Busy from the first await, not the last: Enter auto-repeats, and
    // every press that arrived during the is_complete round trip used to
    // pass the guard and run the same code again.
    this.busy = true;
    this.root.dataset.busy = 'true';
    try {
      const status = await this.handlers.onIsComplete(code);
      if (status === 'incomplete') {
        this._setInput(`${this.input.value}\n`);
        return;
      }

      this._setInput('');
      this.history.push(code);
      this.historyAt = this.history.length;
      this.draft = null;

      this._appendEcho(code);
      try {
        const messages = await this.handlers.onExecute(code);
        this._appendMessages(messages);
      } catch (err) {
        // Stop rejects every in-flight call; without this the command's
        // echo was followed by nothing at all, as if it produced no
        // output rather than having been killed.
        this.log.appendChild(el('div', {
          class: 'console-out console-error', 'data-console-error': true,
        }, [el('div', {}, [err?.message ?? String(err)])]));
      }
    } finally {
      this.busy = false;
      this.root.dataset.busy = 'false';
      this.log.scrollTop = this.log.scrollHeight;
      this.input.focus();
    }
  }

  _appendEcho(code) {
    this.log.appendChild(el('div', { class: 'console-entry', 'data-console-input-echo': true }, [
      el('span', { class: 'console-caret' }, ['>']),
      el('pre', {}, [code]),
    ]));
  }

  _appendMessages(messages) {
    for (const msg of messages) {
      if (msg.msg_type === MSG.STREAM) {
        this.log.appendChild(el('pre', {
          class: 'console-out', 'data-console-stream': msg.content.name,
        }, [msg.content.text]));
      } else if (msg.msg_type === MSG.EXECUTE_RESULT) {
        this.log.appendChild(el('pre', {
          class: 'console-out console-result', 'data-console-result': true,
        }, [msg.content.data['text/plain']]));
      } else if (msg.msg_type === MSG.ERROR) {
        // The same plain-English hint a cell gets. The console is the
        // lowest-friction place to type first Lua, which makes it exactly
        // the audience the hints exist for.
        const hint = hintFor(msg.content.evalue);
        this.log.appendChild(el('div', { class: 'console-out console-error', 'data-console-error': true }, [
          el('div', {}, [`${msg.content.ename}: ${msg.content.evalue}`]),
          hint ? el('p', { class: 'hint', 'data-hint': true }, withCodeSpans(hint)) : null,
          msg.content.traceback?.length
            ? el('pre', {}, [outputText({ output_type: 'error', ...msg.content })])
            : null,
        ]));
      }
    }
  }

  note(text) {
    this.log.appendChild(el('div', { class: 'console-note', 'data-console-note': true }, [text]));
    this.log.scrollTop = this.log.scrollHeight;
  }

  clear() { this.log.replaceChildren(); }
}
