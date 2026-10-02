// The page's test chrome (test/chrome.js), for the lab inside DiRT Launcher.
//
// The page's specs name controls by their `data-toolbar` names and reach the
// app through `window.lab`. The plugin exposes the same `window.lab` over
// the active notebook, and this maps each control name onto the Lab menu
// entry (or command) that does the same thing, so a ported spec keeps
// saying *what* and this says *where*.
import { expect } from '@playwright/test';

/** The Lab menu entry for each control, as [submenu, label] or [label]. */
const MENU_OF = {
  new: ['New notebook'], open: ['Open .ipynb…'], 'open-url': ['Open from URL…'],
  save: ['Save .ipynb'], 'show-source': ['View', 'Show source'],
  'run-all': ['Run all'], 'run-above': ['Run all above'], 'run-below': ['Run all below'],
  stop: ['Stop'], restart: ['Restart'],
  'add-code': ['+ Code'], 'add-markdown': ['+ Markdown'],
  undo: ['Edit', 'Undo'], redo: ['Edit', 'Redo'],
  'cut-cell': ['Edit', 'Cut cell'], 'copy-cell': ['Edit', 'Copy cell'], 'paste-cell': ['Edit', 'Paste cell below'],
  'clear-outputs': ['Edit', 'Clear all outputs'], duplicate: ['Edit', 'Duplicate notebook'], rename: ['Edit', 'Rename notebook…'],
  'hide-code': ['View', 'Hide code'], 'collapse-all': ['View', 'Collapse all code'], 'expand-all': ['View', 'Expand all code'],
  'load-mermaid': ['View', 'Diagram renderer…'],
  'toggle-console': ['Console'], 'panel-outline': ['Outline'], 'panel-swarm': ['Instances'],
  examples: ['Start here…'], 'examples-menu': ['Start here…'], recent: ['Recent'], about: ['About Diluvium Lab'],
};

const exact = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** Opens a top-level menu. A click that lands while the bar still holds a closing menu toggles it shut, so one retry. */
async function openTop(page, top) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('.lm-MenuBar-item', { hasText: top }).click();
    try {
      await expect(page.locator('.lm-Menu:visible')).toHaveCount(1, { timeout: 1500 });
      return;
    } catch { /* closed instead of opened; once more */ }
  }
  throw new Error(`the ${top} menu did not open`);
}

/** Click an entry of a top-level menu by its exact label. */
export async function viaMenu(page, top, label) {
  await openTop(page, top);
  await page.locator('.lm-Menu:visible').first().locator('.lm-Menu-item').filter({ has: page.locator('.lm-Menu-itemLabel', { hasText: exact(label) }) }).first().click();
}

/** An entry of a Lab submenu, opened; the hover opens it after Lumino's delay. The caller clicks it, or reads its state. */
export async function submenuItem(page, top, label) {
  await openTop(page, 'Lab');
  await page.locator('.lm-Menu:visible').first().locator('.lm-Menu-item', { hasText: top }).hover();
  await expect(page.locator('.lm-Menu:visible')).toHaveCount(2);
  return page.locator('.lm-Menu:visible').nth(1).locator('.lm-Menu-item').filter({ has: page.locator('.lm-Menu-itemLabel', { hasText: exact(label) }) }).first();
}

export async function viaSubmenu(page, top, label) {
  await (await submenuItem(page, top, label)).click();
}

/** Controls that replaced the page's one notebook; here they open a panel beside it, so the others close after. */
const REPLACES = new Set(['new', 'open-url', 'duplicate']);

/** After something opened a notebook beside the current one: keep the new one, as the page's replace did. */
export async function replaced(page) {
  // A refused open leaves one notebook, and that is the right answer too.
  await expect(page.locator('.lab-notebook')).toHaveCount(2, { timeout: 3000 }).catch(() => {});
  if ((await page.locator('.lab-notebook').count()) < 2) return;
  await page.evaluate(() => window.lab.closeOtherNotebooks());
  await expect(page.locator('.lab-notebook')).toHaveCount(1);
}

/** The page's `viaControl`: a control by its data-toolbar name, wherever the launcher keeps it. */
export async function viaControl(page, name) {
  const where = MENU_OF[name];
  if (!where) throw new Error(`viaControl: nowhere known holds "${name}"`);
  if (where.length === 2) await viaSubmenu(page, where[0], where[1]);
  else await viaMenu(page, 'Lab', where[0]);
  if (REPLACES.has(name)) await replaced(page);
}

/** The page's first-visit launcher has no counterpart here. */
export async function dismissLauncher() {}

/**
 * The page's `openLab`: the launcher with a notebook open and the kernel
 * idle, from a clean database. Returns the problems the page reports.
 */
export async function openLab(page, { fresh = true } = {}) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  if (fresh) await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await expect(page.locator('.lm-MenuBar-item', { hasText: 'Lab' })).toBeVisible();
  await viaMenu(page, 'Lab', 'Notebook');
  await expect(page.locator('.lab-notebook')).toBeVisible();
  // The page always shows its console under the notebook; the console panel opens there too.
  if ((await page.locator('.lab-console').count()) === 0) await viaMenu(page, 'Lab', 'Console');
  await expect(page.locator('.lab-console [data-console-input]')).toBeVisible();
  await expect(page.locator('.lab-notebook [data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });
  return problems;
}
