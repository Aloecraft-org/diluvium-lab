// Diluvium Lab as a DiRT Launcher plugin: the kernel service, the Notebook
// and Console panels, and the Lab menu. The notebook internals stay the
// lab's plain-JS modules under ../src; this package only gives them a home.
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ILabKernel, IShell, IShortcuts, type DirtPlugin } from '@dirt-launcher/api';
import { KernelService } from './kernel';
import { NotebookPanel } from './notebook';
import { ConsolePanel } from './console';
import './lab.css';

// Surface: every command, and where the Lab menu sits.

/** The Notebook panel; one notebook, in the lab's autosave slot, so the command is a singleton. */
export const OPEN_COMMAND = 'lab:open';
/** The Console panel, sharing the kernel. */
export const CONSOLE_COMMAND = 'lab:console';
/** A blank notebook in place of the open one (the old one goes to the lab's recents). */
export const NEW_COMMAND = 'lab:new';
/** Open .ipynb…: a file picker, then the notebook replaces the open one. */
export const OPEN_FILE_COMMAND = 'lab:open-file';
/** Save .ipynb: downloads the open notebook. */
export const SAVE_COMMAND = 'lab:save';
export const RUN_ALL_COMMAND = 'lab:run-all';
/** Stop: terminates the worker and starts another, so every variable is lost; the label says Stop, never interrupt. */
export const STOP_COMMAND = 'lab:stop';
export const RESTART_COMMAND = 'lab:restart';
/** `lab:add-cell` with `{ type: 'code' | 'markdown' }` adds a cell below the current one. */
export const ADD_CELL_COMMAND = 'lab:add-cell';
/** After File (0), Workspace (10), DRT (20) and Auth (30). */
export const LAB_MENU_RANK = 40;
/** The kernel says what it can do only after it starts, so these are re-read on every status change. */
export const KERNEL_COMMANDS = [STOP_COMMAND, RESTART_COMMAND, RUN_ALL_COMMAND];

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
  description: 'Notebook and console over the Diluvium kernel; .ipynb in and out.',
  requires: [IShell, ILabKernel],
  optional: [IShortcuts],
  activate(app, shell: IShell, kernel: ILabKernel, shortcuts: IShortcuts | null) {
    const { commands } = app;
    let notebook: NotebookPanel | undefined;
    let console_: ConsolePanel | undefined;
    const cellType = (args: ReadonlyPartialJSONObject) => (args.type === 'markdown' ? 'markdown' : 'code');

    shell.addPanel(OPEN_COMMAND, {
      label: 'Notebook',
      caption: 'Open the notebook',
      singleton: true,
      actions: [
        { command: ADD_CELL_COMMAND, args: { type: 'code' }, icon: 'plus', label: 'Add a code cell' },
        { command: RUN_ALL_COMMAND, args: {} },
        { command: STOP_COMMAND, args: {} },
      ],
      create: () => {
        notebook = new NotebookPanel(kernel, shell);
        notebook.disposed.connect(() => (notebook = undefined));
        notebook.changed.connect(() => commands.notifyCommandChanged(SAVE_COMMAND));
        return notebook;
      },
    });
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
    /** The notebook, opened if it is not, with its document restored. */
    const withNotebook = async (): Promise<NotebookPanel> => {
      const panel = (await commands.execute(OPEN_COMMAND, {})) as NotebookPanel;
      await panel.ready;
      return panel;
    };

    commands.addCommand(NEW_COMMAND, {
      label: 'New notebook',
      execute: async () => (await withNotebook()).newNotebook(),
    });
    commands.addCommand(OPEN_FILE_COMMAND, {
      label: 'Open .ipynb…',
      execute: async () => {
        const file = await pickFile('.ipynb,application/json');
        if (file) await (await withNotebook()).openFile(file);
      },
    });
    commands.addCommand(SAVE_COMMAND, {
      label: 'Save .ipynb',
      caption: () => (notebook ? `Download ${notebook.filename}` : 'Download the notebook'),
      isEnabled: () => !!notebook,
      execute: () => notebook?.saveFile(),
    });
    commands.addCommand(RUN_ALL_COMMAND, {
      label: 'Run all',
      caption: 'Run every code cell, top to bottom, stopping at the first error',
      isEnabled: () => !!notebook && kernel.status === 'idle',
      execute: () => notebook?.runAll(),
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
    kernel.statusChanged.connect(() => KERNEL_COMMANDS.forEach(id => commands.notifyCommandChanged(id)));

    const menu = shell.menu(['Lab'], LAB_MENU_RANK);
    menu.addItem({ command: NEW_COMMAND });
    menu.addItem({ command: OPEN_FILE_COMMAND });
    menu.addItem({ command: SAVE_COMMAND });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: OPEN_COMMAND });
    menu.addItem({ command: CONSOLE_COMMAND });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: RUN_ALL_COMMAND });
    menu.addItem({ command: STOP_COMMAND });
    menu.addItem({ command: RESTART_COMMAND });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: ADD_CELL_COMMAND, args: { type: 'code' } });
    menu.addItem({ command: ADD_CELL_COMMAND, args: { type: 'markdown' } });
    shell.menu(['File', 'New']).addItem({ command: OPEN_COMMAND });
    shell.menu(['File', 'New']).addItem({ command: CONSOLE_COMMAND });
    // The command list hides a command that needs args; both cell kinds are listed with theirs.
    shell.addPaletteItem({ command: ADD_CELL_COMMAND, args: { type: 'code' }, category: 'Lab' });
    shell.addPaletteItem({ command: ADD_CELL_COMMAND, args: { type: 'markdown' }, category: 'Lab' });
    shortcuts?.add({ command: OPEN_COMMAND, label: 'Diluvium Lab' });
  },
};

// depth: the file picker

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

export default [kernelPlugin, lab];
