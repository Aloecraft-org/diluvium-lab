// The console pane: scratch execution against the same kernel.
//
// It shares the kernel with the notebook rather than getting one of its own,
// which is the entire point -- poke at a variable the notebook just defined
// without adding a cell you then have to delete.

import { el } from './ui.js';
import { outputText } from './ipynb.js';
import { HighlightedEditor } from './editor.js';
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
    // History, but only from the edges, so arrows still navigate a
    // multi-line draft.
    if (event.key === 'ArrowUp' && this.input.selectionStart === 0 && this.history.length) {
      event.preventDefault();
      this.historyAt = Math.max(0, this.historyAt - 1);
      this._setInput(this.history[this.historyAt] ?? '');
      return;
    }
    if (event.key === 'ArrowDown' && this.input.selectionStart === this.input.value.length) {
      if (this.historyAt >= this.history.length) return;
      event.preventDefault();
      this.historyAt = Math.min(this.history.length, this.historyAt + 1);
      this._setInput(this.history[this.historyAt] ?? '');
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

    const status = await this.handlers.onIsComplete(code);
    if (status === 'incomplete') {
      this._setInput(`${this.input.value}\n`);
      return;
    }

    this.busy = true;
    this.root.dataset.busy = 'true';
    this._setInput('');
    this.history.push(code);
    this.historyAt = this.history.length;

    this._appendEcho(code);
    try {
      const messages = await this.handlers.onExecute(code);
      this._appendMessages(messages);
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
        this.log.appendChild(el('div', { class: 'console-out console-error', 'data-console-error': true }, [
          el('div', {}, [`${msg.content.ename}: ${msg.content.evalue}`]),
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
