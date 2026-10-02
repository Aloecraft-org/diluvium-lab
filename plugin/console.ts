// The Console panel: `src/notebook/console.js` over the shared kernel.
import { Widget } from '@lumino/widgets';
import { ConsoleView } from '../src/notebook/console.js';
import type { ILabKernel, KernelReset } from '@dirt-launcher/api';

/** What the console says when the state it was poking at is gone. */
export const RESET_NOTES: Record<KernelReset, string> = {
  restart: 'Kernel restarted. Every variable is gone.',
  stop: 'Stopped. The kernel restarted, so every variable is gone.',
  switch: 'Switched runtimes. Every variable is gone.',
};

export class ConsolePanel extends Widget {
  readonly console: ConsoleView;
  private readonly input: HTMLTextAreaElement;

  constructor(private readonly kernel: ILabKernel) {
    super();
    this.addClass('lab-console');
    this.title.label = 'Console';
    this.title.caption = 'Scratch execution against the notebook’s kernel';
    this.node.innerHTML = `
      <div class="lab-console-log" data-console-log></div>
      <div class="lab-console-input-row">
        <textarea data-console-input rows="1" spellcheck="false" aria-label="console input"
          placeholder="Enter runs · Shift+Enter adds a line · Ctrl+Space completes"></textarea>
      </div>`;
    this.input = this.node.querySelector('[data-console-input]')!;
    // `languageInfo` and `complete` are read by the constructor but missing from its JSDoc.
    const handlers: Record<string, unknown> = {
      onExecute: (code: string) => kernel.collect(code),
      onIsComplete: (code: string) => kernel.isComplete(code),
      languageInfo: () => kernel.language,
      complete: (code: string, cursor: number) => kernel.complete(code, cursor),
    };
    this.console = new ConsoleView(this.node, handlers as ConstructorParameters<typeof ConsoleView>[1]);
    kernel.languageChanged.connect(this.repaint, this);
    kernel.reset.connect(this.note, this);
    void kernel.start().then(
      () => !this.isDisposed && this.console.note('Kernel ready. Cells and this console share it.'),
      (err: Error) => !this.isDisposed && this.console.note(`The kernel did not start: ${err.message}`),
    );
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.kernel.languageChanged.disconnect(this.repaint, this);
    this.kernel.reset.disconnect(this.note, this);
    super.dispose();
  }

  protected onActivateRequest(): void {
    this.input.focus();
  }

  private repaint(): void {
    this.console.repaintHighlight();
  }

  private note(_: unknown, why: KernelReset): void {
    this.console.note(why === 'switch' ? `Switched to ${this.kernel.label}. Every variable is gone.` : RESET_NOTES[why]);
  }
}
