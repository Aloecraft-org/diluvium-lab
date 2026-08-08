// A highlighted editor that is still a <textarea>.
//
// The textarea keeps its text transparent and its caret visible, and a <pre>
// carrying the highlighted copy sits exactly underneath. Native editing
// survives intact: undo, selection, spellcheck, IME, mobile keyboards,
// screen readers, Cmd+arrow -- all the things a contenteditable or a
// hand-rolled editor quietly breaks.
//
// The cost is that the two boxes must lay text out identically, to the
// pixel. Every property that affects layout is set once, on a shared class,
// and `test/highlight.spec.js` asserts the two boxes measure the same.

import { highlightToHtml } from './highlight.js';
import { attachEditing } from './editing.js';
import { CompletionController } from './completion.js';

export class HighlightedEditor {
  /**
   * @param {HTMLTextAreaElement} textarea already in the document
   * @param {() => object} getOptions supplies { keywords, globals }, read at
   *   paint time so a kernel swap re-colours without rebuilding anything
   * @param {object} [behaviour] `complete` enables Ctrl+Space completion;
   *   `handleEnter` is false where Enter already means something (console)
   */
  constructor(textarea, getOptions = () => ({}), behaviour = {}) {
    this.textarea = textarea;
    this.getOptions = getOptions;

    this.wrap = document.createElement('div');
    this.wrap.className = 'editor-wrap';
    textarea.parentNode.insertBefore(this.wrap, textarea);

    this.pre = document.createElement('pre');
    this.pre.className = 'editor-highlight';
    // The <pre> is a coloured copy of the textarea's text, sitting behind
    // it. To a screen reader it is the same content twice -- and the copy
    // is the one that cannot be edited or navigated. Hide it.
    this.pre.setAttribute('aria-hidden', 'true');
    this.code = document.createElement('code');
    this.pre.appendChild(this.code);

    this.wrap.appendChild(this.pre);
    this.wrap.appendChild(textarea);

    this._onInput = () => this.paint();
    this._onScroll = () => this.syncScroll();
    textarea.addEventListener('input', this._onInput);
    textarea.addEventListener('scroll', this._onScroll);

    // Completion first: it listens in capture, so an open popup takes Enter
    // and Tab before the editing keys or the run shortcut see them.
    this.completion = behaviour.complete
      ? new CompletionController(textarea, behaviour.complete)
      : null;
    this._detachEditing = attachEditing(textarea, {
      isBusy: () => this.completion?.isOpen ?? false,
      handleEnter: behaviour.handleEnter ?? true,
    });

    this.paint();
  }

  paint() {
    // Colour is a nicety; the overlay lining up with the textarea is not.
    // A throw in here used to propagate out through render() and take the
    // whole page down with it -- no cells, no toolbar, no explanation --
    // so a tokenizer that chokes on something now costs the colours and
    // nothing else. `textContent` keeps every character in place, which is
    // the property the caret depends on.
    try {
      this.code.innerHTML = highlightToHtml(this.textarea.value, this.getOptions());
    } catch (err) {
      this.code.textContent = this.textarea.value;
      if (!HighlightedEditor._warnedAboutHighlighting) {
        HighlightedEditor._warnedAboutHighlighting = true;
        console.error('diluvium-lab: syntax highlighting failed; showing plain text', err);
      }
    }
    this.syncScroll();
  }

  syncScroll() {
    this.pre.scrollTop = this.textarea.scrollTop;
    this.pre.scrollLeft = this.textarea.scrollLeft;
  }

  destroy() {
    this.completion?.close();
    this._detachEditing?.();
    this.textarea.removeEventListener('input', this._onInput);
    this.textarea.removeEventListener('scroll', this._onScroll);
    // put the textarea back where it was, so a re-render can re-wrap it
    this.wrap.parentNode?.insertBefore(this.textarea, this.wrap);
    this.wrap.remove();
  }
}
