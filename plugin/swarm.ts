// The Instances panel: a swarm while it runs, over `src/notebook/swarm-view.js`
// (which draws the topology through `topology-view.js`). The panel holds the
// state the view repaints from, as `src/app.js` did: the last report, the
// chosen program, the listener composer's draft and a staged database.
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ILabKernel, SwarmReport } from '@dirt-launcher/api';
import { renderSwarm } from '../src/notebook/swarm-view.js';
import { SWARM_PROGRAMS, ALL_PROGRAMS, programById } from '../src/notebook/swarm-programs.js';
import { looksLikeSqlite } from '../src/kernel/sqlite.js';

// Surface: how far one press of Run advances the swarm.

/** Steps one Run is worth, and how long any one slice may sit in wasm before yielding. */
export const RUN_STEPS = 200;
export const RUN_BUDGET_MS = 50;
/** A request is driven until the program answers it, in shorter slices. */
export const REQUEST_BUDGET_MS = 30;

type Program = { id: string; label: string; source?: string; config?: Record<string, any> };
type Draft = { method: string; path: string; body: string };
type Staged = { name: string; bytes: Uint8Array } | null;

export interface InstancesOptions {
  kernel: ILabKernel;
  /** The selected code cell's source, for the "from the selected cell" program; throws when there is none. */
  selectedCellSource: () => string;
  notify: (message: string) => void;
}

export class InstancesPanel extends Widget {
  report: SwarmReport | null = null;
  source: string = SWARM_PROGRAMS[0].id;
  busy = false;
  draft: Draft = { method: 'GET', path: '/', body: '' };
  staged: Staged = null;
  /** The report changed, for anything else that shows the swarm. */
  readonly changed = new Signal<this, void>(this);
  private readonly kernel: ILabKernel;
  private readonly body: HTMLElement;

  constructor(private readonly options: InstancesOptions) {
    super();
    this.kernel = options.kernel;
    this.addClass('lab-instances');
    this.title.label = 'Instances';
    this.title.caption = 'A swarm, while it is running';
    this.node.innerHTML = `<div class="lab-instances-body" data-instances></div>`;
    this.body = this.node.querySelector('[data-instances]')!;
    this.kernel.statusChanged.connect(this.refresh, this);
    this.kernel.reset.connect(this.dropped, this);
    this.refresh();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.kernel.statusChanged.disconnect(this.refresh, this);
    this.kernel.reset.disconnect(this.dropped, this);
    super.dispose();
  }

  /** Repaint from the held state; the view keeps no DOM between paints. */
  refresh(): void {
    const scrolled = this.body.scrollTop;
    this.body.replaceChildren();
    // `busy`, `draft`, `staged` and `programs` are read by the view but missing from its JSDoc.
    const options: Record<string, unknown> = {
      report: this.report,
      capable: this.kernel.capabilities.swarm === true,
      busy: this.busy,
      source: this.source,
      draft: this.draft,
      staged: this.staged,
      programs: ALL_PROGRAMS,
      onChange: (patch: Partial<this>) => { Object.assign(this, patch); this.refresh(); },
      // A draft field must not repaint, or the input is rebuilt under the caret.
      onDraft: (patch: Partial<Draft>) => { Object.assign(this.draft, patch); },
      onAction: (action: string, arg?: unknown) => void this.act(action, arg),
    };
    renderSwarm(this.body, options as Parameters<typeof renderSwarm>[1]);
    this.body.scrollTop = scrolled;
  }

  /**
   * A cell may have started a swarm from Lua; after one runs, the panel
   * takes a snapshot so it shows what the kernel holds. A courtesy, never a
   * reason to fail the cell.
   */
  async sync(): Promise<void> {
    if (this.kernel.capabilities.swarm !== true || this.busy) return;
    try {
      this.report = await this.kernel.kernel.swarmSnapshot();
      this.refresh();
      this.changed.emit();
    } catch { /* the cell's own result stands */ }
  }

  // depth: the actions, serialised through `busy` because dvs_step is synchronous on the far side

  private async act(action: string, arg?: unknown): Promise<void> {
    if (this.busy && action !== 'stop') return;
    this.busy = true;
    this.refresh();
    const { kernel } = this.kernel;
    try {
      switch (action) {
        case 'start': {
          const program = programById(this.source) as Program;
          const source = program.source ?? this.options.selectedCellSource();
          this.report = await kernel.swarmStart(source, this.config(program));
          break;
        }
        case 'open-database': {
          const file = arg as File;
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (!looksLikeSqlite(bytes)) throw new Error(`${file.name} does not begin "SQLite format 3", so it is not a database file`);
          this.staged = { name: databaseNameOf(file.name), bytes };
          break;
        }
        case 'rename-database':
          if (this.staged) this.staged = { ...this.staged, name: databaseNameOf(String(arg)) };
          break;
        case 'clear-database':
          this.staged = null;
          break;
        case 'export-database': {
          const name = String(arg ?? '');
          const bytes = await kernel.swarmDatabaseExport(name);
          if (!bytes) throw new Error(name ? `no database named '${name}' has been opened in this deployment's scope` : 'this swarm wired no database, so there is nothing to export');
          downloadBytes(name || 'lab.sqlite', bytes);
          break;
        }
        case 'step':
          this.report = await kernel.swarmStep();
          break;
        case 'run':
          await this.drive({ steps: RUN_STEPS, budgetMs: RUN_BUDGET_MS });
          break;
        case 'stop':
          this.report = await kernel.swarmStop();
          break;
        case 'request':
          await kernel.swarmRequest(arg as { method: string; path: string; body?: string });
          await this.drive({ steps: RUN_STEPS, budgetMs: REQUEST_BUDGET_MS, done: report => !report.listener?.pending?.length });
          break;
        case 'kill': case 'hibernate': case 'wake': {
          const result = await kernel.swarmControl(action, arg as number);
          if (result.status !== 'ok') this.options.notify(`${action}: ${result.detail ?? result.status}`);
          this.report = await kernel.swarmSnapshot();
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.options.notify((err as Error).message);
    } finally {
      this.busy = false;
      this.refresh();
      this.changed.emit();
    }
  }

  /** Advance by a step allowance in as many slices as the clock needs; see app.js's note on why the clock only yields. */
  private async drive({ steps, budgetMs, done }: { steps: number; budgetMs: number; done?: (report: SwarmReport) => boolean }): Promise<void> {
    let spent = 0;
    while (spent < steps) {
      const report = await this.kernel.kernel.swarmRun({ maxSteps: steps - spent, budgetMs });
      this.report = report;
      if (!report.alive || !report.steps || done?.(report)) break;
      spent += report.steps as number;
    }
  }

  /** The program's configuration, with a staged database folded into its sql connector. */
  private config(program: Program): Record<string, unknown> | undefined {
    const sql = program.config?.connectors?.sql;
    if (!this.staged || !sql) return program.config;
    return {
      ...program.config,
      connectors: {
        ...program.config!.connectors,
        sql: { ...(sql === true ? {} : sql), databases: { [this.staged.name]: this.staged.bytes } },
      },
    };
  }

  /** The swarm died with the kernel that hosted it. */
  private dropped(): void {
    this.report = null;
    this.refresh();
    this.changed.emit();
  }
}

function databaseNameOf(name: string): string {
  const base = String(name ?? '').split(/[/\\]/).pop()!.replace(/\0/g, '');
  return base === '' || base === '.' || base === '..' ? 'lab.db' : base.slice(0, 127);
}

/** Hand bytes to the browser as a file. */
function downloadBytes(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.sqlite3' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name.endsWith('.sqlite') || name.endsWith('.db') ? name : `${name}.sqlite`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
