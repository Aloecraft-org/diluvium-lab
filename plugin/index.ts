// Diluvium Lab as a DiRT Launcher plugin: the kernel service, the Notebook,
// Console and Outline panels, and the Lab menu. The notebook internals stay
// the lab's plain-JS modules under ../src; this package only gives them a home.
import type { CommandRegistry } from '@lumino/commands';
import type { JSONValue, ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { DockPanel, Menu, Widget } from '@lumino/widgets';
import { ILabKernel, IShell, IShortcuts, IWorkspaceConfig, type DirtPlugin, type KeyBinding } from '@dirt-launcher/api';
import { EXAMPLES, exampleById } from '../src/notebook/examples.js';
import { fetchNotebook, describeOpenError, hostOf } from '../src/notebook/remote.js';
import { listRecent, clearRecent } from '../src/notebook/storage.js';
import { KernelService } from './kernel';
import { ConsolePanel } from './console';
import { OutlinePanel } from './outline';
import { NotebookPanel, PAGE_SLOT, newSlot, type NotebookArgs, type NotebookSource } from './notebook';
import './lab.css';

// Surface: every command, the Lab menu's place, and the shortcuts.

/** The Notebook panel; `{ slot }` names its storage, the page's own notebook when absent. One panel per slot. */
export const OPEN_COMMAND = 'lab:open';
/** The Console panel, sharing the kernel. */
export const CONSOLE_COMMAND = 'lab:console';
/** The Outline panel, following the active notebook; opened beside it. */
export const OUTLINE_COMMAND = 'lab:outline';
/** A blank notebook in a new panel. */
export const NEW_COMMAND = 'lab:new';
/** Open .ipynb…: a file picker, then a new panel. */
export const OPEN_FILE_COMMAND = 'lab:open-file';
/** Open from URL…: asks for an address, fetches it (the one request a Lab makes for a notebook), then a new panel. */
export const OPEN_URL_COMMAND = 'lab:open-url';
/** `lab:open-example { id }`: a bundled notebook in a new panel. */
export const OPEN_EXAMPLE_COMMAND = 'lab:open-example';
/** `lab:open-recent { openedAt }`: a remembered notebook, from the stored copy. */
export const OPEN_RECENT_COMMAND = 'lab:open-recent';
export const FORGET_RECENT_COMMAND = 'lab:forget-recent';
/** Start here: the examples and a blank notebook, in a dialog; the first run's step and a dashboard tile. */
export const START_COMMAND = 'lab:start-here';
/** Save .ipynb: downloads the active notebook. */
export const SAVE_COMMAND = 'lab:save';
export const RUN_ALL_COMMAND = 'lab:run-all';
/** `lab:run-range { which: 'above' | 'below' }`, relative to the current cell. */
export const RUN_RANGE_COMMAND = 'lab:run-range';
/** `lab:run-cell { advance }`: the current cell; Ctrl Enter, and Shift Enter with `advance`. */
export const RUN_CELL_COMMAND = 'lab:run-cell';
/** Stop: terminates the worker and starts another, so every variable is lost; the label says Stop, never interrupt. */
export const STOP_COMMAND = 'lab:stop';
export const RESTART_COMMAND = 'lab:restart';
/** `lab:add-cell { type: 'code' | 'markdown' }` adds a cell below the current one. */
export const ADD_CELL_COMMAND = 'lab:add-cell';
/** `lab:runtime { id }`: switch to a build; toggled for the running one. */
export const RUNTIME_COMMAND = 'lab:runtime';
/** Asks the mirror which builds exist. The only request the Lab makes that is not a notebook someone opened. */
export const RUNTIME_CHECK_COMMAND = 'lab:runtime-check';
/** After File (0), Workspace (10), DRT (20) and Auth (30). */
export const LAB_MENU_RANK = 40;
/** The kernel says what it can do only after it starts, so these are re-read on every status change. */
export const KERNEL_COMMANDS = [STOP_COMMAND, RESTART_COMMAND, RUN_ALL_COMMAND, RUN_RANGE_COMMAND, RUNTIME_COMMAND, RUNTIME_CHECK_COMMAND];
/** The page's shortcuts, as the launcher's registry: the user may change them under Preferences > Keyboard. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { keys: ['Ctrl Enter'], command: RUN_CELL_COMMAND, args: { advance: false }, selector: '.lab-notebook' },
  { keys: ['Shift Enter'], command: RUN_CELL_COMMAND, args: { advance: true }, selector: '.lab-notebook' },
  { keys: ['Accel S'], command: SAVE_COMMAND, selector: '.lab-notebook' },
];
/** The `lab` workspace section: the runtime pin. Open notebooks are the layout's, by slot. */
export const SECTION_ID = 'lab';
/** How wide the outline opens beside a notebook, as a share of the pair. */
export const OUTLINE_SHARE = 0.22;

const kernelPlugin: DirtPlugin<ILabKernel> = {
  id: 'diluvium-lab:kernel',
  label: 'Diluvium Kernel',
  family: 'Lab',
  license: 'Apache-2.0',
  description: 'The Diluvium WASM kernel, in a worker, shared by every notebook and the console.',
  provides: ILabKernel,
  activate: () => new KernelService(),
};

const lab: DirtPlugin = {
  id: 'diluvium-lab:plugin',
  label: 'Diluvium Lab',
  family: 'Lab',
  license: 'Apache-2.0',
  description: 'Notebooks, a console and an outline over the Diluvium kernel; .ipynb in and out; any build the mirror carries.',
  requires: [IShell, ILabKernel],
  optional: [IShortcuts, IWorkspaceConfig],
  activate(app, shell: IShell, kernel: ILabKernel, shortcuts: IShortcuts | null, config: IWorkspaceConfig | null) {
    const { commands } = app;
    const notebooks = new Set<NotebookPanel>();
    /** The notebook that was last opened, clicked or focused: what Save, Run all and the outline act on. */
    let active: NotebookPanel | undefined;
    const activeChanged = new Signal<unknown, void>(lab);
    let console_: ConsolePanel | undefined;
    let outline: OutlinePanel | undefined;
    const cellType = (args: ReadonlyPartialJSONObject) => (args.type === 'markdown' ? 'markdown' : 'code');
    const setActive = (panel: NotebookPanel | undefined) => {
      if (panel === active) return;
      active = panel;
      activeChanged.emit();
      [SAVE_COMMAND, RUN_ALL_COMMAND, RUN_RANGE_COMMAND].forEach(id => commands.notifyCommandChanged(id));
    };

    // The panels.
    shell.addPanel(OPEN_COMMAND, {
      label: args => (args.slot && args.slot !== PAGE_SLOT ? 'Notebook' : 'Notebook'),
      caption: 'Open the notebook',
      singleton: true,
      actions: [
        { command: ADD_CELL_COMMAND, args: { type: 'code' }, icon: 'plus', label: 'Add a code cell' },
        { command: RUN_ALL_COMMAND, args: {} },
        { command: STOP_COMMAND, args: {} },
      ],
      create: args => {
        const { slot = PAGE_SLOT } = args as NotebookArgs;
        const panel: NotebookPanel = new NotebookPanel({
          kernel, slot, initial: pending.get(slot), notify: m => shell.notify(m),
          onRuntimeMenu: anchor => runtimeMenu(anchor),
        });
        pending.delete(slot);
        notebooks.add(panel);
        panel.node.addEventListener('focusin', () => setActive(panel));
        panel.disposed.connect(() => {
          notebooks.delete(panel);
          if (active === panel) setActive([...notebooks].at(-1));
          void refreshRecent();
        });
        panel.changed.connect(() => commands.notifyCommandChanged(SAVE_COMMAND));
        setActive(panel);
        void panel.ready.then(refreshRecent);
        return panel;
      },
    });
    /** A document waiting for the panel its command opens: `lab:open { slot }` takes JSON only. */
    const pending = new Map<string, NotebookSource>();
    /** Opens a new panel over a fresh slot, with `source` when given. */
    const openNew = async (source?: NotebookSource): Promise<NotebookPanel> => {
      const slot = newSlot();
      if (source) pending.set(slot, source);
      const panel = (await commands.execute(OPEN_COMMAND, { slot })) as NotebookPanel;
      await panel.ready;
      return panel;
    };
    /** The active notebook, or the page's one opened if none is. */
    const withNotebook = async (): Promise<NotebookPanel> => {
      if (active && !active.isDisposed) return active;
      const panel = (await commands.execute(OPEN_COMMAND, {})) as NotebookPanel;
      await panel.ready;
      return panel;
    };
    shell.addPanel(CONSOLE_COMMAND, {
      label: 'Console',
      caption: 'A console on the notebook’s kernel',
      singleton: true,
      create: () => {
        console_ = new ConsolePanel(kernel);
        console_.disposed.connect(() => (console_ = undefined));
        return console_;
      },
    });
    shell.addPanel(OUTLINE_COMMAND, {
      label: 'Outline',
      caption: 'The active notebook’s headings, beside it',
      singleton: true,
      create: () => {
        outline = new OutlinePanel();
        outline.setNotebook(active);
        outline.disposed.connect(() => (outline = undefined));
        // Beside the notebook rather than in its tab bar, once the dock holds both.
        requestAnimationFrame(() => outline && placeBeside(outline, active));
        return outline;
      },
    });
    activeChanged.connect(() => outline?.setNotebook(active));

    // Opening notebooks.
    commands.addCommand(NEW_COMMAND, { label: 'New notebook', execute: () => openNew() });
    commands.addCommand(OPEN_FILE_COMMAND, {
      label: 'Open .ipynb…',
      execute: async () => {
        const file = await pickFile('.ipynb,application/json');
        if (!file) return;
        await openSource({ text: await file.text(), name: file.name || 'notebook.ipynb', origin: 'file' });
      },
    });
    commands.addCommand(OPEN_URL_COMMAND, {
      label: 'Open from URL…',
      caption: 'Fetches a notebook from an address you give; nothing is fetched until you say so',
      execute: async () => {
        const url = await askUrl(shell);
        if (!url) return;
        try {
          const got = (await fetchNotebook(url)) as { text: string; url: string; name: string; rewrittenFrom?: string | null };
          await openSource({ text: got.text, name: got.name, origin: 'url', url: got.url });
          shell.notify(got.rewrittenFrom ? `Opened ${got.name} (rewritten to its raw URL)` : `Opened ${got.name} from ${hostOf(got.url)}`);
        } catch (err) {
          shell.notify(describeOpenError(err));
        }
      },
    });
    commands.addCommand(OPEN_EXAMPLE_COMMAND, {
      label: args => exampleById(String(args.id))?.title ?? 'Example',
      caption: args => exampleById(String(args.id))?.summary ?? '',
      isVisible: args => !!exampleById(String(args.id)),
      execute: async args => {
        const example = exampleById(String(args.id));
        if (!example) return void shell.notify(`There is no example called ${args.id}.`);
        await openSource({ text: example.source, name: example.file, origin: 'example' });
      },
    });
    commands.addCommand(OPEN_RECENT_COMMAND, {
      label: args => recentLabel(args),
      caption: args => recentCaption(args),
      isVisible: args => recents.some(r => r.openedAt === args.openedAt),
      execute: async args => {
        const entry = recents.find(r => r.openedAt === args.openedAt);
        if (!entry) return;
        if (entry.ipynb) return void (await openSource({ text: entry.ipynb, name: entry.name, origin: entry.origin, url: entry.url }));
        if (entry.url) return void (await commands.execute(OPEN_URL_COMMAND));
        shell.notify(`${entry.name} was too large to keep a copy of, and it came from a file.`);
      },
    });
    commands.addCommand(FORGET_RECENT_COMMAND, {
      label: 'Forget all',
      isEnabled: () => recents.length > 0,
      execute: async () => {
        const ok = await shell.dialog({
          title: 'Forget recent notebooks',
          body: 'Forget every remembered notebook, including copies kept when notebooks were closed? Saved .ipynb files are not touched.',
          buttons: [{ label: 'Cancel', value: false }, { label: 'Forget all', value: true, primary: true }],
        });
        if (!ok) return;
        await clearRecent().catch(() => {});
        await refreshRecent();
        shell.notify('Recent notebooks forgotten.');
      },
    });
    commands.addCommand(START_COMMAND, {
      label: 'Start here…',
      caption: 'The guided notebooks, or a blank one',
      execute: () => startHere(shell, commands),
    });
    /** A document into a new panel; a bad one is a notice and opens nothing. */
    const openSource = async (source: NotebookSource) => {
      try {
        await openNew(source);
      } catch (err) {
        shell.notify(`Could not open ${source.name}: ${describeOpenError(err)}`);
      }
    };

    // Acting on the active notebook.
    commands.addCommand(SAVE_COMMAND, {
      label: 'Save .ipynb',
      caption: () => (active ? `Download ${active.filename}` : 'Download the notebook'),
      isEnabled: () => !!active,
      execute: () => active?.saveFile(),
    });
    commands.addCommand(RUN_ALL_COMMAND, {
      label: 'Run all',
      caption: 'Run every code cell, top to bottom, stopping at the first error',
      isEnabled: () => !!active && kernel.status === 'idle',
      execute: () => active?.runAll(),
    });
    commands.addCommand(RUN_RANGE_COMMAND, {
      label: args => (args.which === 'above' ? 'Run all above' : 'Run all below'),
      caption: args => (args.which === 'above' ? 'Run the code cells above the current one' : 'Run the current code cell and every one below it'),
      isVisible: args => args.which === 'above' || args.which === 'below',
      isEnabled: () => !!active && kernel.status === 'idle',
      execute: args => active?.runRange(args.which === 'above' ? 'above' : 'below'),
    });
    commands.addCommand(RUN_CELL_COMMAND, {
      label: args => (args.advance ? 'Run cell and advance' : 'Run cell'),
      caption: args => (args.advance ? 'Run the current cell, then move to the next' : 'Run the current cell'),
      isEnabled: () => !!active,
      execute: args => active?.runSelected({ advance: args.advance === true }),
    });
    commands.addCommand(STOP_COMMAND, {
      label: 'Stop',
      caption: 'Stop the running cell. This restarts the kernel, so every variable is lost.',
      isEnabled: () => kernel.status === 'busy' && kernel.capabilities.interrupt === true,
      execute: () => kernel.stop().then(() => shell.notify('Stopped the running cell.'), (e: Error) => shell.notify(`Could not stop the kernel: ${e.message}`)),
    });
    commands.addCommand(RESTART_COMMAND, {
      label: 'Restart',
      caption: 'Restart the kernel. Every variable is gone afterwards.',
      isEnabled: () => kernel.status !== 'starting',
      execute: () => kernel.restart().then(() => shell.notify('Kernel restarted.'), (e: Error) => shell.notify(`Restart failed: ${e.message}`)),
    });
    commands.addCommand(ADD_CELL_COMMAND, {
      label: args => (cellType(args) === 'markdown' ? '+ Markdown' : '+ Code'),
      caption: args => `Add a ${cellType(args)} cell below the current one`,
      isVisible: args => args.type === 'code' || args.type === 'markdown',
      execute: async args => (await withNotebook()).addCell(cellType(args)),
    });

    // Runtimes: the bundled build, cached ones, and the mirror's once asked.
    commands.addCommand(RUNTIME_COMMAND, {
      label: args => kernel.runtimes.find(r => r.id === args.id)?.label ?? String(args.id),
      caption: args => {
        const r = kernel.runtimes.find(x => x.id === args.id);
        return r?.prerelease ? 'A prerelease build' : r?.remote ? 'Fetched from the mirror and verified the first time' : '';
      },
      isVisible: args => kernel.runtimes.some(r => r.id === args.id),
      isToggled: args => kernel.runtime === args.id,
      isEnabled: () => kernel.status !== 'starting',
      execute: async args => {
        const id = String(args.id);
        if (id === kernel.runtime) return;
        const label = kernel.runtimes.find(r => r.id === id)?.label ?? id;
        shell.notify(`Switching to ${label}…`);
        try {
          await kernel.selectRuntime(id);
          section.changed.emit();
          shell.notify(`Switched to ${label}. Every variable is gone.`);
        } catch (err) {
          shell.notify(`Could not load ${label}: ${(err as Error).message}`);
        }
      },
    });
    commands.addCommand(RUNTIME_CHECK_COMMAND, {
      label: 'Check the mirror for builds…',
      caption: () => kernel.switchUnavailableReason ?? 'Look for other Diluvium builds on the release mirror',
      isEnabled: () => kernel.canSwitch,
      execute: async () => {
        try {
          const before = kernel.runtimes.length;
          await kernel.checkRuntimes();
          const found = kernel.runtimes.filter(r => r.remote).length;
          shell.notify(found ? `The mirror lists ${found} other build${found === 1 ? '' : 's'}.` : `The mirror lists no other builds yet.${before ? '' : ''}`);
        } catch (err) {
          shell.notify(`Checking the mirror failed: ${(err as Error).message}`);
        }
      },
    });
    const runtimeItems = (): Menu.IItemOptions[] => [
      ...kernel.runtimes.map(r => ({ command: RUNTIME_COMMAND, args: { id: r.id } })),
      { type: 'separator' as const },
      { command: RUNTIME_CHECK_COMMAND },
    ];
    /** The footer's runtime button: the same list, over the button. */
    const runtimeMenu = (anchor: HTMLElement) => {
      const menu = new Menu({ commands });
      for (const item of runtimeItems()) menu.addItem(item);
      const rect = anchor.getBoundingClientRect();
      // Disposing inside aboutToClose re-enters close(); a microtask later the menu is detached and dispose is quiet.
      menu.aboutToClose.connect(() => queueMicrotask(() => menu.dispose()));
      // Lumino flips the list upward when it would run off the bottom, which over a footer it always would.
      menu.open(rect.left, rect.top);
    };
    kernel.statusChanged.connect(() => KERNEL_COMMANDS.forEach(id => commands.notifyCommandChanged(id)));

    // The runtime pin travels with the workspace; a remembered build comes back only from the cache.
    const section = { changed: new Signal<unknown, void>(lab) };
    config?.register({
      id: SECTION_ID,
      label: 'Lab',
      export: () => ({ runtime: kernel.runtime }) as unknown as JSONValue,
      import: data => {
        const runtime = data && typeof data === 'object' && !Array.isArray(data) && typeof data.runtime === 'string' ? data.runtime : undefined;
        if (!runtime) return;
        void (kernel as KernelService).restoreRuntime?.(runtime).then(restored => {
          if (!restored) shell.notify(`This workspace last used ${runtime}, but its bytes are not cached. Staying on the bundled build; pick it under Lab > Runtime to fetch it again.`);
        });
      },
      changed: section.changed,
    });

    // The Lab menu.
    const menu = shell.menu(['Lab'], LAB_MENU_RANK);
    menu.addItem({ command: START_COMMAND });
    menu.addItem({ command: NEW_COMMAND });
    menu.addItem({ command: OPEN_FILE_COMMAND });
    menu.addItem({ command: OPEN_URL_COMMAND });
    const examples = shell.menu(['Lab', 'Examples']);
    for (const { id } of EXAMPLES) examples.addItem({ command: OPEN_EXAMPLE_COMMAND, args: { id } });
    const recent = shell.menu(['Lab', 'Recent']);
    menu.addItem({ command: SAVE_COMMAND });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: OPEN_COMMAND });
    menu.addItem({ command: CONSOLE_COMMAND });
    menu.addItem({ command: OUTLINE_COMMAND });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: RUN_ALL_COMMAND });
    menu.addItem({ command: RUN_RANGE_COMMAND, args: { which: 'above' } });
    menu.addItem({ command: RUN_RANGE_COMMAND, args: { which: 'below' } });
    menu.addItem({ command: STOP_COMMAND });
    menu.addItem({ command: RESTART_COMMAND });
    const runtimes = shell.menu(['Lab', 'Runtime']);
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: ADD_CELL_COMMAND, args: { type: 'code' } });
    menu.addItem({ command: ADD_CELL_COMMAND, args: { type: 'markdown' } });
    shell.menu(['File', 'New']).addItem({ command: OPEN_COMMAND });
    shell.menu(['File', 'New']).addItem({ command: CONSOLE_COMMAND });
    const fill = (target: Menu, items: Menu.IItemOptions[]) => {
      target.clearItems();
      for (const item of items) target.addItem(item);
    };
    const refreshRuntimes = () => fill(runtimes, runtimeItems());
    kernel.runtimesChanged.connect(refreshRuntimes);
    refreshRuntimes();
    // The command list hides a command that needs args; both cell kinds and every example are listed with theirs.
    shell.addPaletteItem({ command: ADD_CELL_COMMAND, args: { type: 'code' }, category: 'Lab' });
    shell.addPaletteItem({ command: ADD_CELL_COMMAND, args: { type: 'markdown' }, category: 'Lab' });
    for (const { id } of EXAMPLES) shell.addPaletteItem({ command: OPEN_EXAMPLE_COMMAND, args: { id }, category: 'Lab examples' });
    for (const binding of KEY_BINDINGS) shell.addKeyBinding(binding);
    shortcuts?.add({ command: START_COMMAND, label: 'Start here' });
    shortcuts?.add({ command: OPEN_COMMAND, label: 'Diluvium Lab' });

    // depth: the recents submenu follows the lab's store

    let recents: RecentEntry[] = [];
    const recentLabel = (args: ReadonlyPartialJSONObject) => {
      const r = recents.find(x => x.openedAt === args.openedAt);
      return r ? r.title || r.name : 'Recent notebook';
    };
    const recentCaption = (args: ReadonlyPartialJSONObject) => {
      const r = recents.find(x => x.openedAt === args.openedAt);
      return r ? `${r.url ?? (r.origin === 'file' ? 'opened from a file' : r.origin === 'replaced' ? 'kept when it was closed' : r.source)} · ${relativeTime(r.openedAt)}` : '';
    };
    const refreshRecent = async () => {
      try {
        recents = (await listRecent()) as RecentEntry[];
      } catch {
        recents = [];
      }
      fill(recent, [
        ...recents.map(r => ({ command: OPEN_RECENT_COMMAND, args: { openedAt: r.openedAt } })),
        ...(recents.length ? [{ type: 'separator' as const }] : []),
        { command: FORGET_RECENT_COMMAND },
      ]);
    };
    void refreshRecent();
  },
};

/** A remembered notebook, as `storage.js` keeps it. */
interface RecentEntry {
  openedAt: number;
  name: string;
  title: string | null;
  origin: NotebookSource['origin'];
  url: string | null;
  source: string;
  ipynb: string | null;
}

// depth: dialogs, placement, and the file picker

/** Start here: the bundled notebooks and a blank one. */
async function startHere(shell: IShell, commands: CommandRegistry): Promise<void> {
  const body = new Widget();
  body.addClass('lab-start');
  const lead = document.createElement('p');
  lead.className = 'lab-start-lead';
  lead.textContent = 'Each opens as a notebook beside this one. Cells and the console share one kernel, running in this tab.';
  body.node.append(lead);
  let picked: (() => Promise<unknown>) | undefined;
  const entry = (title: string, summary: string, count: string, run: () => Promise<unknown>) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example-entry';
    button.innerHTML = `<span class="example-title"></span><span class="example-count"></span><span class="example-summary"></span>`;
    const [t, c, s] = button.children as unknown as HTMLElement[];
    t.textContent = title;
    c.textContent = count;
    s.textContent = summary;
    button.onclick = () => {
      picked = run;
      button.closest('.dirt-dialog')?.querySelector<HTMLElement>('.btn-primary')?.click();
    };
    return button;
  };
  body.node.append(
    entry('Blank notebook', 'Start typing in an empty one.', '', () => commands.execute(NEW_COMMAND)),
    ...EXAMPLES.map(e => entry(e.title, e.summary, `${e.cells} cells`, () => commands.execute(OPEN_EXAMPLE_COMMAND, { id: e.id }))),
  );
  await shell.dialog({ title: 'Start here', body, buttons: [{ label: 'Close', value: false }, { label: 'Open', value: true, primary: true }] });
  await picked?.();
}

async function askUrl(shell: IShell): Promise<string | undefined> {
  const body = new Widget();
  const input = document.createElement('input');
  input.className = 'form-control form-control-sm lab-url-field';
  input.placeholder = 'https://raw.githubusercontent.com/…/notebook.ipynb';
  input.setAttribute('data-url-input', '');
  const note = document.createElement('p');
  note.className = 'lab-url-note';
  note.textContent = 'A GitHub page address is rewritten to its raw file. The host must allow cross-origin reads.';
  body.node.append(input, note);
  const ok = await shell.dialog({ title: 'Open a notebook from a URL', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Open', value: true, primary: true }] });
  return ok && input.value.trim() ? input.value.trim() : undefined;
}

/** Moves a tool panel to the left of a notebook it follows, narrow, when both are in the same dock. */
function placeBeside(panel: Widget, notebook: Widget | undefined): void {
  const dock = panel.parent;
  if (!(dock instanceof DockPanel) || !notebook || notebook.parent !== dock) return;
  dock.addWidget(panel, { mode: 'split-left', ref: notebook });
  const layout = dock.saveLayout();
  const shrink = (area: DockPanelArea | null): void => {
    if (!area || area.type !== 'split-area') return;
    const i = area.children.findIndex(c => c.type === 'tab-area' && c.widgets.includes(panel));
    if (i !== -1 && area.children.length === 2) area.sizes = i === 0 ? [OUTLINE_SHARE, 1 - OUTLINE_SHARE] : [1 - OUTLINE_SHARE, OUTLINE_SHARE];
    else area.children.forEach(shrink);
  };
  shrink(layout.main);
  dock.restoreLayout(layout);
  dock.activateWidget(notebook);
}
type DockPanelArea = ReturnType<DockPanel['saveLayout']>['main'];

/** Resolves with the chosen file, or undefined when the dialog is dismissed. */
function pickFile(accept: string): Promise<File | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files?.[0]);
      input.remove();
    };
    // A dismissed dialog fires no change; `cancel` arrives in current browsers, and focus is the fallback.
    input.oncancel = () => {
      resolve(undefined);
      input.remove();
    };
    document.body.append(input);
    input.click();
  });
}

/** "just now", "3 minutes ago", a date past a month: the page's own wording. */
function relativeTime(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export default [kernelPlugin, lab];
