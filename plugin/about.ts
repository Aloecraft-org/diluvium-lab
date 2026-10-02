// The plugin's front page under Plugins > Lab: what this build is, as the
// page's About says it, with a block to paste into a bug report.
import { Widget } from '@lumino/widgets';
import type { ILabKernel } from '@dirt-launcher/api';
import { LAB_VERSION, LAB_COMMIT } from '../src/version.js';
import { BUNDLED } from '../vendor/pinned.js';
import { PINNED } from '../src/kernel/runtimes.js';

export class AboutPage extends Widget {
  constructor(private readonly kernel: ILabKernel, private readonly notify: (message: string) => void) {
    super();
    this.addClass('lab-about');
    this.render();
    kernel.statusChanged.connect(this.render, this);
    kernel.runtimesChanged.connect(this.render, this);
    kernel.languageChanged.connect(this.render, this);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.kernel.statusChanged.disconnect(this.render, this);
    this.kernel.runtimesChanged.disconnect(this.render, this);
    this.kernel.languageChanged.disconnect(this.render, this);
    super.dispose();
  }

  /** Every fact a bug report should carry, read from the thing it describes. */
  facts(): [string, string][] {
    const { kernel } = this;
    const bundled = kernel.runtime === PINNED;
    const entry = kernel.runtimes.find(r => r.id === kernel.runtime);
    const has = (fn: () => unknown) => { try { return fn() ? 'yes' : 'no'; } catch (err) { return `blocked (${(err as Error).name})`; } };
    return [
      ['Lab', `${LAB_VERSION}${LAB_COMMIT ? ` (${String(LAB_COMMIT).slice(0, 12)})` : ''}, as a DiRT Launcher plugin`],
      ['Diluvium', bundled ? BUNDLED.version : entry?.label ?? kernel.runtime],
      ['Release tag', bundled ? BUNDLED.tag : kernel.runtime],
      ['Release status', bundled ? (BUNDLED.stable === false ? 'prerelease' : 'release') : entry?.prerelease ? 'prerelease' : 'release'],
      ['Source', bundled ? 'bundled with this build' : 'downloaded from the mirror and verified'],
      ['Kernel sha256', bundled ? BUNDLED.sha256 : 'verified at download; not recorded here'],
      ['Diluvium commit', bundled ? BUNDLED.commit : 'see the mirror’s BUILDINFO.txt'],
      ['Built', bundled ? BUNDLED.built : 'unknown'],
      ['Reported by the kernel', kernel.language.version ?? 'not started'],
      ['Execution', kernel.kernel.offThread === false ? `in the page — ${kernel.kernel.fallbackReason ?? 'no worker'}` : 'in a worker (Stop available)'],
      ['Kernel', `${kernel.label}, ${kernel.status}`],
      ['Notebook format', 'ipynb 4.5'],
      ['Browser', navigator.userAgent],
      ['  WebAssembly', has(() => typeof WebAssembly?.Module === 'function')],
      ['  Web Worker', has(() => typeof Worker === 'function')],
      ['  crypto.subtle', has(() => !!crypto?.subtle)],
      ['  secure context', has(() => isSecureContext)],
      ['  IndexedDB', has(() => !!indexedDB)],
      ['  CSS color-mix', has(() => CSS?.supports?.('color', 'color-mix(in srgb, red 50%, blue)'))],
    ];
  }

  report(): string {
    return this.facts().map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  private render(): void {
    const facts = this.facts();
    this.node.replaceChildren();
    const head = document.createElement('div');
    head.className = 'lab-about-head';
    head.innerHTML = `<h2>Diluvium Lab</h2><p>A notebook front end for Diluvium: cells, a console and kernel controls over a Lua kernel in this tab. Every fact below is read from the thing it describes.</p>`;
    const list = document.createElement('dl');
    list.className = 'lab-about-facts';
    for (const [term, value] of facts) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    const pre = document.createElement('pre');
    pre.className = 'lab-about-report';
    pre.setAttribute('data-about-report', '');
    pre.textContent = this.report();
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm btn-outline-secondary';
    copy.textContent = 'Copy for a bug report';
    copy.onclick = () => navigator.clipboard.writeText(this.report()).then(
      () => this.notify('Copied. Paste it into the bug report.'),
      () => this.notify('Could not reach the clipboard — select the text and copy it.'),
    );
    this.node.append(head, list, pre, copy);
  }
}
