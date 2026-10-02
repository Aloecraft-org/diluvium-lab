// The kernel service: one WorkerKernel per launcher, over the vendored wasm,
// swapped for another build when a runtime is picked.
//
// Vite inlines the worker script (`?worker&inline` hands back a constructor
// over a blob) and the wasm (`?url` becomes a data: URL in the one-file
// build), so the packed launcher carries the kernel the way the lab's bake
// does, and the dev server serves both from ../diluvium-lab.
import { Signal } from '@lumino/signaling';
import type { ILabKernel, KernelMessage, KernelReset, KernelStatus, LabKernelObject, LanguageInfo, RuntimeEntry } from '@dirt-launcher/api';
import KernelWorker from '../src/kernel/kernel-worker.js?worker&inline';
import wasmUrl from '../vendor/libdiluvium_wasi.wasm?url';
import swarmUrl from '../vendor/diluvium_swarm_wasi.wasm?url';
import { BUNDLED } from '../vendor/pinned.js';
import { WorkerKernel } from '../src/kernel/worker-kernel.js';
import { RuntimeRegistry, PINNED } from '../src/kernel/runtimes.js';
import { STATUS } from '../src/kernel/kernel.js';
import { MSG } from '../src/kernel/protocol.js';
import { FALLBACK_KEYWORDS, FALLBACK_GLOBALS, FALLBACK_SYNTAX } from '../src/notebook/highlight.js';

// Surface: what a human might change.

/** How long the kernel may take to come up before `start` fails rather than hangs. */
export const START_TIMEOUT_MS = 30_000;
/** What the kernel is called in the UI before it says which build it is. */
export const KERNEL_LABEL = 'On-page WASM';

/** `swarmUrl` and `createWorker` are read by the lab's constructors but missing from their JSDoc. */
type LooseOptions = Record<string, unknown>;

export class KernelService implements ILabKernel {
  kernel: LabKernelObject;
  readonly statusChanged = new Signal<this, KernelStatus>(this);
  readonly languageChanged = new Signal<this, void>(this);
  readonly reset = new Signal<this, KernelReset>(this);
  readonly runtimesChanged = new Signal<this, void>(this);
  language: LanguageInfo = { keywords: FALLBACK_KEYWORDS, globals: FALLBACK_GLOBALS, syntax: FALLBACK_SYNTAX, version: null };
  runtime: string = PINNED;
  /** The same object as `kernel`, typed as the lab's class for what only a worker kernel has. */
  private worker: WorkerKernel;
  private readonly registry: RuntimeRegistry;
  private unwatch?: () => void;
  private starting?: Promise<void>;
  private switching = false;

  constructor() {
    const createWorker = () => new KernelWorker();
    // Only when the bundled release publishes a swarm module: null is how a runtime says it has no swarm layer.
    const bundledSwarm = BUNDLED.swarm ? swarmUrl : null;
    this.worker = new WorkerKernel({ wasmUrl, swarmUrl: bundledSwarm, label: KERNEL_LABEL, createWorker } as LooseOptions);
    this.kernel = this.worker as unknown as LabKernelObject;
    this.registry = new RuntimeRegistry({
      wasmUrl,
      swarmUrl: bundledSwarm,
      pinnedLabel: BUNDLED.version,
      pinnedIsPrerelease: BUNDLED.stable === false,
      createWorker,
    } as LooseOptions);
    this.watch();
  }

  get status(): KernelStatus {
    return this.worker.status as KernelStatus;
  }

  get label(): string {
    return this.worker.label;
  }

  get capabilities(): Record<string, boolean> {
    return this.worker.capabilities;
  }

  get runtimes(): readonly RuntimeEntry[] {
    return this.registry.entries().map(({ id, label, remote, prerelease }: RuntimeEntry) => ({ id, label, remote, prerelease }));
  }

  get canSwitch(): boolean {
    return this.registry.canSwitch;
  }

  get switchUnavailableReason(): string | null {
    return this.registry.unavailableReason;
  }

  start(): Promise<void> {
    if (this.status !== STATUS.DEAD || this.starting) return this.starting ?? Promise.resolve();
    this.starting = (async () => {
      try {
        await withTimeout(this.worker.start(), START_TIMEOUT_MS, `the kernel did not start within ${START_TIMEOUT_MS / 1000} seconds`);
        await this.refreshLanguage();
        // Which builds were downloaded before: local, so it costs nothing and lists them without asking the mirror.
        await this.registry.loadCached();
        this.runtimesChanged.emit();
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  execute(code: string, onMessage: (msg: KernelMessage) => void = () => {}): Promise<KernelMessage> {
    return this.kernel.execute(code, onMessage);
  }

  async collect(code: string): Promise<KernelMessage[]> {
    if (this.status === STATUS.DEAD) {
      return [{ msg_type: MSG.ERROR, content: { ename: 'KernelError', evalue: 'the kernel is not running', traceback: [] } }];
    }
    const messages: KernelMessage[] = [];
    await this.kernel.execute(code, msg => void messages.push(msg));
    return messages;
  }

  async complete(code: string, cursor: number): Promise<{ matches: string[] }> {
    if (this.status === STATUS.DEAD || !this.capabilities.complete) return { matches: [] };
    return (await this.kernel.complete(code, cursor)).content as { matches: string[] };
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
      throw new Error(this.worker.fallbackReason
        ? `This kernel runs in the page and cannot be stopped (${this.worker.fallbackReason}).`
        : 'This kernel cannot be stopped.');
    }
    await this.kernel.interrupt();
    await this.refreshLanguage();
    this.reset.emit('stop');
  }

  // depth: runtimes (the registry fetches, verifies and probes; the swap happens only on success)

  async checkRuntimes(): Promise<void> {
    await this.registry.check();
    this.runtimesChanged.emit();
  }

  async selectRuntime(id: string): Promise<void> {
    if (id === this.runtime || this.switching) return;
    this.switching = true;
    this.statusChanged.emit('starting');
    try {
      const { kernel } = await this.registry.load(id);
      const old = this.worker;
      this.unwatch?.();
      this.worker = kernel;
      this.kernel = kernel as unknown as LabKernelObject;
      this.runtime = id;
      this.watch();
      await old.shutdown().catch(() => {});
      await this.refreshLanguage();
      await this.registry.loadCached();
    } finally {
      this.switching = false;
      this.statusChanged.emit(this.status);
    }
    this.runtimesChanged.emit();
    this.reset.emit('switch');
  }

  /** A remembered runtime comes back only from the cache: nothing is downloaded at startup. */
  async restoreRuntime(id: string): Promise<boolean> {
    if (!id || id === this.runtime) return true;
    if (!(await this.registry.isCached(id).catch(() => false))) return false;
    await this.selectRuntime(id);
    return true;
  }

  private watch(): void {
    this.unwatch = this.worker.onMessage((msg: KernelMessage) => {
      if (msg.msg_type === MSG.STATUS) this.statusChanged.emit(msg.content.execution_state);
    });
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
