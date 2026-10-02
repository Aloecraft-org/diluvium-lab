// The one service this package provides: the kernel every notebook and the
// console share. Local to the package until a second plugin needs it, at
// which point the Token moves to @dirt-launcher/api (README: Services).
import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';
import type { WorkerKernel } from '../src/kernel/worker-kernel.js';

/** A Jupyter-shaped kernel message: `src/kernel/protocol.js` makes them. */
export interface KernelMessage {
  msg_type: string;
  msg_id?: string;
  content: Record<string, any>;
}

/** What the highlighter colours, read from the running kernel once it answers. */
export interface LanguageInfo {
  keywords: readonly string[];
  globals: readonly string[];
  syntax: readonly string[];
  version: string | null;
}

/** Kernel lifecycle states, spelled as `src/kernel/kernel.js` spells them. */
export type KernelStatus = 'starting' | 'idle' | 'busy' | 'dead';

/** Why the Lua state went away; notebooks mark their outputs stale on any of them. */
export type KernelReset = 'restart' | 'stop';

export interface ILabKernel {
  /** The lab's own kernel object, for callers that need its full interface (bytecode, instances, swarm). */
  readonly kernel: WorkerKernel;
  readonly status: KernelStatus;
  /** "On-page WASM (worker)", or "(in page)" where no worker could start. */
  readonly label: string;
  readonly language: LanguageInfo;
  readonly capabilities: Record<string, boolean>;
  readonly statusChanged: ISignal<ILabKernel, KernelStatus>;
  readonly languageChanged: ISignal<ILabKernel, void>;
  /** The state was discarded; the argument says by what. */
  readonly reset: ISignal<ILabKernel, KernelReset>;
  /** Brings the kernel up; idempotent, and the first panel to open calls it. */
  start(): Promise<void>;
  /** Runs code; `onMessage` sees the stream, result and error messages in order. Resolves with the execute_reply. */
  execute(code: string, onMessage?: (msg: KernelMessage) => void): Promise<KernelMessage>;
  /** Runs code and returns every message it published, as the console wants it. */
  collect(code: string): Promise<KernelMessage[]>;
  complete(code: string, cursor: number): Promise<{ matches: string[]; cursor_start?: number; cursor_end?: number }>;
  /** 'complete', 'incomplete' or 'invalid'. */
  isComplete(code: string): Promise<string>;
  restart(): Promise<void>;
  /** Terminates the worker and starts another: the only stop a synchronous kernel has, and it loses every variable. */
  stop(): Promise<void>;
}
export const ILabKernel = new Token<ILabKernel>('diluvium-lab:kernel', 'The Diluvium kernel notebooks and the console share.');
