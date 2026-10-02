import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// The lab as a launcher plugin, driven through the launcher's own menus.
// Nothing is mocked: every run goes to the worker kernel over the vendored
// wasm, inlined by the launcher's build.

async function openLauncher(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  // The lab's autosave restores across reloads by design; start clean.
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await expect(page.locator('.lm-MenuBar-item', { hasText: 'Lab' })).toBeVisible();
  return problems;
}

/** Click an entry of a top-level menu by its exact label ("Notebook" is not "New notebook"). */
async function viaMenu(page, top, label) {
  await page.locator('.lm-MenuBar-item', { hasText: top }).click();
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  await page.locator('.lm-Menu-item:visible').filter({ has: page.locator('.lm-Menu-itemLabel', { hasText: exact }) }).first().click();
}

const notebook = (page) => page.locator('.lab-notebook');
const cells = (page) => page.locator('.lab-notebook .cell');
const consolePanel = (page) => page.locator('.lab-console');

async function openNotebook(page) {
  await viaMenu(page, 'Lab', 'Notebook');
  await expect(notebook(page)).toBeVisible();
  await expect(notebook(page).locator('[data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });
}

/** Type into the last cell and run it, the way a person would. */
async function runInLastCell(page, source) {
  const cell = cells(page).last();
  const editor = cell.locator('[data-editor]');
  await editor.fill(source);
  await editor.press('Control+Enter');
  await expect(cell).toHaveAttribute('data-busy', 'false');
  return cell;
}

test('a notebook runs a cell, the console reads its state, and the .ipynb round-trips', async ({ page }) => {
  const problems = await openLauncher(page);
  await openNotebook(page);

  // + Code from the Lab menu, then a cell that leaves state behind.
  const before = await cells(page).count();
  await viaMenu(page, 'Lab', '+ Code');
  await expect(cells(page)).toHaveCount(before + 1);
  const cell = await runInLastCell(page, 'shared = 6 * 7\nprint("answer", shared)');
  const output = cell.locator('[data-outputs] .output').first();
  await expect(output).toHaveAttribute('data-output-type', 'stream');
  await expect(output).toContainText('answer\t42');
  await expect(cell.locator('[data-prompt]')).toHaveText('In [1]:');

  // The console shares the kernel: it sees the cell's variable.
  await viaMenu(page, 'Lab', 'Console');
  await expect(consolePanel(page)).toBeVisible();
  await expect(consolePanel(page).locator('[data-console-note]').first()).toContainText('Kernel ready');
  const input = consolePanel(page).locator('[data-console-input]');
  await input.fill('shared + 1');
  await input.press('Enter');
  await expect(consolePanel(page).locator('[data-console-result]').first()).toHaveText('43');

  // Save .ipynb downloads nbformat 4 with the output in it.
  const download = page.waitForEvent('download');
  await viaMenu(page, 'Lab', 'Save .ipynb');
  const saved = await (await download).path();
  const ipynb = JSON.parse(await readFile(saved, 'utf8'));
  expect(ipynb.nbformat).toBe(4);
  const codeCells = ipynb.cells.filter((c) => c.cell_type === 'code');
  expect(codeCells.at(-1).source.join('')).toBe('shared = 6 * 7\nprint("answer", shared)');
  expect(codeCells.at(-1).outputs[0].text.join('')).toContain('answer\t42');

  // New notebook replaces it with a blank one; Open .ipynb… brings it back, outputs and all.
  await viaMenu(page, 'Lab', 'New notebook');
  await expect(cells(page)).toHaveCount(1);
  await expect(cells(page).first().locator('[data-editor]')).toHaveValue('');
  const chooser = page.waitForEvent('filechooser');
  await viaMenu(page, 'Lab', 'Open .ipynb\u2026');
  await (await chooser).setFiles(saved);
  await expect(cells(page)).toHaveCount(before + 1);
  await expect(cells(page).last().locator('[data-outputs] .output').first()).toContainText('answer\t42');
  await expect(cells(page).last().locator('[data-prompt]')).toHaveText('In [1]:');
  await expect(cells(page).last()).toHaveAttribute('data-run-state', 'ok');

  expect(problems).toEqual([]);
});

test('Run all, Stop and Restart drive the shared kernel from the menu', async ({ page }) => {
  await openLauncher(page);
  await openNotebook(page);
  // The seed notebook: Run all runs its three code cells in order.
  await viaMenu(page, 'Lab', 'Run all');
  const code = page.locator('.lab-notebook .cell[data-cell-type="code"]');
  await expect(code.nth(0).locator('[data-prompt]')).toHaveText('In [1]:');
  await expect(code.nth(1).locator('[data-prompt]')).toHaveText('In [2]:');
  await expect(code.nth(2).locator('[data-prompt]')).toHaveText('In [3]:');
  await expect(code.nth(0).locator('[data-outputs]')).toContainText('hello, world!');

  // A cell that never returns leaves the page usable; Stop ends it and marks what ran stale.
  await viaMenu(page, 'Lab', '+ Code');
  const runaway = cells(page).last();
  await runaway.locator('[data-editor]').fill('while true do end');
  await runaway.locator('[data-editor]').press('Control+Enter');
  await expect(notebook(page)).toHaveAttribute('data-kernel-state', 'busy');
  await viaMenu(page, 'Lab', 'Stop');
  await expect(notebook(page).locator('[data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });
  await expect(code.nth(0)).toHaveAttribute('data-run-state', 'stale');
  await expect(runaway.locator('[data-outputs] .output').first()).toContainText('stopped');

  // After a restart the state is gone and the counter starts over.
  await viaMenu(page, 'Lab', 'Restart');
  await expect(notebook(page).locator('[data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });
  const probe = await runInLastCell(page, 'print(shared == nil, counter == nil)');
  await expect(probe.locator('[data-outputs]')).toContainText('true\ttrue');
  await expect(probe.locator('[data-prompt]')).toHaveText('In [1]:');
});
