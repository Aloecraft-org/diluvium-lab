import { test, expect } from '@playwright/test';
import { dismissLauncher } from './chrome.js';

// The tool workbench: a rail of tools on the left edge and one collapsible
// panel. The outline -- markdown headings as a table of contents, the way
// Jupyter's TOC and Colab's outline pane read -- is its first tool, but
// the rail and panel are generic: these tests hold for any registered
// tool, and the outline-specific ones say so.

async function openLab(page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
  await page.evaluate(async () => {
    const { clearAutosave, clearRecent } = await import('./src/notebook/storage.js');
    await clearAutosave();
    await clearRecent();
  });
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
}

const railButton = (page) => page.locator('[data-tool-rail] [data-tool="outline"]');
const panel = (page) => page.locator('[data-tool-panel]');
const entries = (page) => page.locator('.outline-entry');

// A first visit seeds the sample notebook, which has headings. These
// heading-free tests want a bare page: delete every cell, which leaves
// the one blank code cell the model always keeps.
const blankNotebook = (page) => page.evaluate(() => {
  const model = window.lab.model;
  for (const cell of [...model.cells]) model.deleteCell(cell.id);
});

test.describe('the tool panel', () => {
  test('starts collapsed, with the outline on the rail', async ({ page }) => {
    await openLab(page);
    await expect(railButton(page)).toBeVisible();
    await expect(railButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(panel(page)).toBeHidden();
  });

  test('opens from the rail, and the same button collapses it', async ({ page }) => {
    await openLab(page);
    await railButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(railButton(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-tool-panel-title]')).toHaveText('Outline');

    await railButton(page).click();
    await expect(panel(page)).toBeHidden();
    await expect(railButton(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('the close button collapses it too', async ({ page }) => {
    await openLab(page);
    await railButton(page).click();
    await page.locator('[data-tool-panel-close]').click();
    await expect(panel(page)).toBeHidden();
    await expect(railButton(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('open or closed survives a reload', async ({ page }) => {
    await openLab(page);
    await railButton(page).click();
    await expect(panel(page)).toBeVisible();

    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(panel(page)).toBeVisible();
    await expect(railButton(page)).toHaveAttribute('aria-pressed', 'true');

    await page.locator('[data-tool-panel-close]').click();
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('the outline', () => {
  test('a notebook with no headings says so rather than showing a gap', async ({ page }) => {
    await openLab(page);
    await blankNotebook(page);
    await railButton(page).click();
    await expect(page.locator('.outline-empty')).toBeVisible();
  });

  test('lists every markdown heading, in order, with its depth', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('language'));
    await railButton(page).click();

    // language.ipynb's headings, which are stable enough to name.
    await expect(entries(page)).toHaveCount(7);
    await expect(entries(page).first()).toHaveText('What Diluvium adds to Lua');
    await expect(entries(page).first()).toHaveAttribute('data-level', '1');
    await expect(entries(page).nth(4)).toHaveText('4. switch');
    await expect(entries(page).nth(4)).toHaveAttribute('data-level', '2');
  });

  test('clicking an entry selects its cell and brings it into view', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('language'));
    await railButton(page).click();

    const last = entries(page).last();
    const cellId = await last.getAttribute('data-outline-cell');
    await last.click();

    const cell = page.locator(`[data-cell-id="${cellId}"]`);
    await expect(cell).toHaveAttribute('data-selected', 'true');
    // In view means inside the sheet's viewport, not just "exists".
    const sheet = await page.locator('.sheet').boundingBox();
    const box = await cell.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(sheet.y - 1);
    expect(box.y).toBeLessThan(sheet.y + sheet.height);
  });

  test('marks the section the selection is in, not just heading cells', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('language'));
    await railButton(page).click();

    // Jump to the last section, then select the *code* cell after its
    // heading; the heading entry should stay the active one.
    const last = entries(page).last();
    const headingCell = await last.getAttribute('data-outline-cell');
    await last.click();
    const after = await page.evaluate((id) => {
      const cells = window.lab.model.cells;
      const at = cells.findIndex((c) => c.id === id);
      const next = cells.slice(at + 1).find((c) => c.cell_type === 'code');
      return next?.id ?? null;
    }, headingCell);
    expect(after).not.toBeNull();

    await page.locator(`[data-cell-id="${after}"]`).click();
    await expect(entries(page).last()).toHaveAttribute('data-active', 'true');
    await expect(entries(page).first()).toHaveAttribute('data-active', 'false');
  });

  test('follows edits: a new heading appears without reopening anything', async ({ page }) => {
    await openLab(page);
    await blankNotebook(page);
    await railButton(page).click();
    await expect(page.locator('.outline-empty')).toBeVisible();

    await page.evaluate(() => {
      const cell = window.lab.model.addCell('markdown');
      window.lab.model.setSource(cell.id, '# Grown while open\n\nprose\n\n## And a subsection');
    });
    await expect(entries(page)).toHaveCount(2);
    await expect(entries(page).first()).toHaveText('Grown while open');
    await expect(entries(page).nth(1)).toHaveText('And a subsection');

    // And headings inside a code fence stay out of it.
    await page.evaluate(() => {
      const cell = window.lab.model.addCell('markdown');
      window.lab.model.setSource(cell.id, '```lua\n# not a heading\n```\n');
    });
    await expect(entries(page)).toHaveCount(2);
  });

  test('a replaced notebook replaces the outline', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('language'));
    await railButton(page).click();
    await expect(entries(page)).toHaveCount(7);

    await page.evaluate(() => window.lab.openExample('messaging'));
    await expect(entries(page).first()).toHaveText('Messages and queues');
  });
});
