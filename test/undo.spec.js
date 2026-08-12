import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// Structural undo/redo: a snapshot stack inside the model covering the
// operations that restructure the document -- add, delete, move, type
// change, paste, clear outputs, rename -- plus each run of typing between
// them, captured as a single session step. Not keystrokes: inside an
// editor, Ctrl+Z stays the textarea's native undo, and the two meet only
// at session edges.

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

const cells = (page) => page.locator('.cell');

test.describe('structural undo', () => {
  test('undo restores a deleted cell, outputs and all', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('print("precious")');
    await page.locator('.cell [data-action="run"]').click();
    await expect(page.locator('.cell [data-outputs]')).toContainText('precious');

    await page.locator('.cell [data-action="delete"]').click();
    await expect(page.locator('.cell [data-editor]')).toHaveValue('');

    await viaControl(page, 'undo');
    await expect(page.locator('.cell [data-editor]')).toHaveValue('print("precious")');
    // The outputs came back with the cell -- the snapshot is the whole
    // document, not just its shape.
    await expect(page.locator('.cell [data-outputs]')).toContainText('precious');
  });

  test('redo does it again, and a new edit forks history', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await viaControl(page, 'add-code');
    await expect(cells(page)).toHaveCount(2);

    await viaControl(page, 'undo');
    await expect(cells(page)).toHaveCount(1);
    await viaControl(page, 'redo');
    await expect(cells(page)).toHaveCount(2);

    // Undo, then a different edit: redo has nothing left to redo.
    await viaControl(page, 'undo');
    await viaControl(page, 'add-markdown');
    const canRedo = await page.evaluate(() => window.lab.model.canRedo);
    expect(canRedo).toBe(false);
  });

  test('a move is one undo step', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('-- first');
    await viaControl(page, 'add-code');
    await page.locator('.cell').nth(1).locator('[data-editor]').fill('-- second');

    await page.locator('.cell').nth(0).locator('[data-action="move-down"]').click();
    await expect(page.locator('.cell').nth(0).locator('[data-editor]')).toHaveValue('-- second');

    await viaControl(page, 'undo');
    await expect(page.locator('.cell').nth(0).locator('[data-editor]')).toHaveValue('-- first');
  });

  test('clear all outputs is undoable', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('return 9');
    await page.locator('.cell [data-action="run"]').click();
    await expect(page.locator('.cell [data-outputs]')).toContainText('9');

    await viaControl(page, 'clear-outputs');
    await expect(page.locator('.cell [data-outputs] .output')).toHaveCount(0);
    await viaControl(page, 'undo');
    await expect(page.locator('.cell [data-outputs]')).toContainText('9');
  });

  test('a rename is undoable too', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('[data-nb-title]').click();
    await page.locator('[data-nb-title-input]').fill('Named on purpose');
    await page.locator('[data-nb-title-input]').press('Enter');
    await expect(page.locator('[data-nb-title]')).toHaveText('Named on purpose');

    await viaControl(page, 'undo');
    await expect(page.locator('[data-nb-title]')).toHaveText('Untitled notebook');
  });

  test('Ctrl+Z works outside an editor and leaves editors alone', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await viaControl(page, 'add-code');
    await expect(cells(page)).toHaveCount(2);

    // Focus is nowhere in particular; Ctrl+Z is the document's.
    await page.locator('.sheet').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+z');
    await expect(cells(page)).toHaveCount(1);

    // Inside an editor, Ctrl+Z belongs to the textarea's own undo: the
    // cell count must not change however often it is pressed.
    await viaControl(page, 'add-code');
    await expect(cells(page)).toHaveCount(2);
    const editor = page.locator('.cell').nth(1).locator('[data-editor]');
    await editor.fill('typed');
    await editor.press('Control+z');
    await expect(cells(page)).toHaveCount(2);
  });

  test('running a cell is not an undo step', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('return 1');
    // The fill was a typing session (one step); the run itself must not
    // add another.
    const before = await page.evaluate(() => window.lab.model._undoStack.length);
    await page.locator('.cell [data-action="run"]').click();
    await expect(page.locator('.cell [data-outputs]')).toContainText('1');
    const after = await page.evaluate(() => window.lab.model._undoStack.length);
    expect(after).toBe(before);
  });

  test('a typing session is one step, and a structural undo cannot eat it', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('kept = true');

    await viaControl(page, 'add-code');
    await expect(cells(page)).toHaveCount(2);

    // Undo removes the added cell -- and ONLY the added cell. The typed
    // text was captured as its own step and survives.
    await viaControl(page, 'undo');
    await expect(cells(page)).toHaveCount(1);
    await expect(page.locator('.cell [data-editor]')).toHaveValue('kept = true');

    // One more undo takes back the typing session itself.
    await viaControl(page, 'undo');
    await expect(page.locator('.cell [data-editor]')).toHaveValue('');
  });
});
