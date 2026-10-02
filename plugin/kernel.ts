// The kernel service: one WorkerKernel per launcher, over the vendored wasm.
//
// Vite inlines the worker script (`?worker&inline` hands back a constructor
// over a blob) and the wasm (`?url` becomes a data: URL in the one-file
// build), so the packed launcher carries the kernel the way the lab's bake
// does, and the dev server serves both from ../diluvium-lab.
import { Signal } from '@lumino/signaling';
import KernelWorker from '../src/kernel/kernel-worker.js?worker&inline';
import wasmUrl from '../vendor/libdiluvium_wasi.wasm?url';
import swarmUrl from '../vendor/diluvium_swarm_wasi.wasm?url';
import { BUNDLED } from '../vendor/pinned.js';
import { WorkerKernel } from '../src/kernel/worker-kernel.js';
import { STATUS } from '../src/kernel/kernel.js';
import { MSG } from '../src/kernel/protocol.js';
import { FALLBACK_KEYWORDS, FALLBACK_GLOBALS, FALLBACK_SYNTAX } from '../src/notebook/highlight.js';
import type { ILabKernel, KernelMessage, KernelReset, KernelStatus, LanguageInfo } from './api';

// Surface: what a human might change.

/** How long the kernel may take to come up before `start` fails rather than hangs. */
export const START_TIMEOUT_MS = 30_000;
/** What the kernel is called in the UI before it says which build it is. */
export const KERNEL_LABEL = 'On-page WASM';

export class KernelService implements ILabKernel {
  readonly kernel: WorkerKernel;
  readonly statusChanged = new Signal<this, KernelStatus>(this);
  readonly languageChanged = new Signal<this, void>(this);
  readonly reset = new Signal<this, KernelReset>(this);
  language: LanguageInfo = { keywords: FALLBACK_KEYWORDS, globals: FALLBACK_GLOBALS, syntax: FALLBACK_SYNTAX, version: null };
  private starting?: Promise<void>;

  constructor() {
    // `swarmUrl` is read by the constructor but missing from its JSDoc, so the options are typed loosely.
    const options: Record<string, unknown> = {
      wasmUrl,
      // Only when the bundled release publishes one: null is how a runtime says it has no swarm layer.
      swarmUrl: BUNDLED.swarm ? swarmUrl : null,
      label: KERNEL_LABEL,
      createWorker: () => new KernelWorker(),
    };
    this.kernel = new WorkerKernel(options);
    this.kernel.onMessage((msg: KernelMessage) => {
      if (msg.msg_type === MSG.STATUS) this.statusChanged.emit(msg.content.execution_state);
    });
  }

  get status(): KernelStatus {
    return this.kernel.status as KernelStatus;
  }

  get label(): string {
    return this.kernel.label;
  }

  get capabilities(): Record<string, boolean> {
    return this.kernel.capabilities;
  }

  start(): Promise<void> {
    if (this.status !== STATUS.DEAD || this.starting) return this.starting ?? Promise.resolve();
    this.starting = (async () => {
      try {
        await withTimeout(this.kernel.start(), START_TIMEOUT_MS, `the kernel did not start within ${START_TIMEOUT_MS / 1000} seconds`);
        await this.refreshLanguage();
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  execute(code: string, onMessage: (msg: KernelMessage) => void = () => {}): Promise<KernelMessage> {
    return this.kernel.execute(code, onMessage as () => void);
  }

  async collect(code: string): Promise<KernelMessage[]> {
    if (this.status === STATUS.DEAD) {
      return [{ msg_type: MSG.ERROR, content: { ename: 'KernelError', evalue: 'the kernel is not running', traceback: [] } }];
    }
    const messages: KernelMessage[] = [];
    await this.kernel.execute(code, ((msg: KernelMessage) => void messages.push(msg)) as () => void);
    return messages;
  }

  async complete(code: string, cursor: number): Promise<{ matches: string[] }> {
    if (this.status === STATUS.DEAD || !this.capabilities.complete) return { matches: [] };
    return (await this.kernel.complete(code, cursor)).content;
  }

  async isComplete(code: string): Promise<string> {
    if (this.status === STATUS.DEAD) return 'complete';
    return (await this.kernel.isComplete(code)).content.status;
  }

  async restart(): Promise<void> {
    await this.kernel.restart();
    await this.refreshLanguage();
    this.reset.emit('restart');
  }

  async stop(): Promise<void> {
    if (!this.capabilities.interrupt) {
      throw new Error(this.kernel.fallbackReason
        ? `This kernel runs in the page and cannot be stopped (${this.kernel.fallbackReason}).`
        : 'This kernel cannot be stopped.');
    }
    await this.kernel.interrupt();
    await this.refreshLanguage();
    this.reset.emit('stop');
  }

  // depth: asking the kernel which words it reserves, so a build that adds a keyword colours it

  private async refreshLanguage(): Promise<void> {
    try {
      const info = await this.kernel.languageInfo();
      if (!info?.keywords?.length) return;
      this.language = info;
      this.languageChanged.emit();
    } catch (err) {
      console.warn('diluvium-lab: could not read the kernel language info', err);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}
