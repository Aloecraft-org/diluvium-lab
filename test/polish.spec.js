import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// The visual-state layer: selection, run state, stale, folding, timing.
//
// These are the states the UI had nowhere to hang before -- `:focus-within`
// was the only "current cell" cue, and a cell that succeeded and one that
// failed both set `data-busy="false"` and nothing else. Everything the
// polish pass adds (a rail colour, a fold, an elapsed clock) reads one of
// these, so the states are what is tested rather than the pixels.

async function openLab(page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
  // Clear once, through the Lab's own module -- not via addInitScript,
  // which re-runs on the reload these tests depend on and would wipe the
  // thing under test. (The trap documented in storage.spec.js.)
  await page.evaluate(async () => {
    const { clearAutosave } = await import('./src/notebook/storage.js');
    await clearAutosave();
  });
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
}

/** The model index of the first code cell -- cells[0] is markdown. */
const firstCodeIndex = (page) => page.evaluate(() =>
  window.lab.model.cells.findIndex((c) => c.cell_type === 'code'));

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();

test.describe('running the selected cell from anywhere', () => {
  test('Ctrl+Enter works with focus outside the editor', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('answered = "yes"\nprint(answered)');
    // Selection without focus: clicking the prompt margin makes the cell
    // current but leaves no editor focused -- exactly the state the
    // page-level fallback exists for.
    await cell.locator('.prompt').click();
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Control+Enter');
    await expect(cell.locator('.output-stream pre')).toContainText('yes');
  });
});
const runFirst = async (page, source) => {
  const cell = codeCell(page);
  await cell.locator('[data-editor]').fill(source);
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell).toHaveAttribute('data-busy', 'false');
  return cell;
};

test.describe('a cell is always current', () => {
  test('selecting one marks it, independent of focus', async ({ page }) => {
    await openLab(page);
    // Something is current from the start -- otherwise the moment focus
    // leaves for the page toolbar (Run all), nothing on the page is.
    const selected = page.locator('.cell[data-selected="true"]');
    await expect(selected).toHaveCount(1);

    const second = page.locator('.cell').nth(1);
    await second.locator('[data-editor]').click();
    await expect(second).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('.cell[data-selected="true"]')).toHaveCount(1);
  });

  test('running a cell makes it current', async ({ page }) => {
    await openLab(page);
    // So that after Run all, the last cell run is the one left highlighted.
    await runFirst(page, 'return 1');
    await expect(codeCell(page)).toHaveAttribute('data-selected', 'true');
  });

  test('selection survives a structural re-render', async ({ page }) => {
    await openLab(page);
    const second = page.locator('.cell').nth(1);
    await second.locator('[data-editor]').click();
    // A structural change with no selection intent of its own -- the menu
    // "+ Cell" both inserts and selects, which would be testing something
    // else. The model API is the raw re-render.
    await page.evaluate(() => window.lab.model.addCell('code'));
    await expect(second).toHaveAttribute('data-selected', 'true');
  });
});

test.describe('a run leaves a trace of how it went', () => {
  test('success and failure are told apart', async ({ page }) => {
    await openLab(page);
    // The gap the pass exists to close: both used to be just
    // data-busy="false".
    const ok = await runFirst(page, 'return 1 + 1');
    await expect(ok).toHaveAttribute('data-run-state', 'ok');

    const bad = page.locator('.cell').nth(1);
    await bad.locator('[data-editor]').fill('error("boom")');
    await bad.locator('[data-editor]').press('Control+Enter');
    await expect(bad).toHaveAttribute('data-run-state', 'error');
  });

  test('an untouched cell has no run state', async ({ page }) => {
    await openLab(page);
    await expect(codeCell(page)).not.toHaveAttribute('data-run-state', /.+/);
  });

  test('run state is derived, so it survives a reload', async ({ page }) => {
    await openLab(page);
    await runFirst(page, 'error("kept across reload")');
    await page.waitForTimeout(600);            // let autosave land
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]');
    await dismissLauncher(page);
    // No kernel needed to know this cell errored -- the error output says so.
    await expect(codeCell(page)).toHaveAttribute('data-run-state', 'error');
  });
});

test.describe('stale: the state Jupyter lacks', () => {
  test('a restart keeps the count and marks it stale', async ({ page }) => {
    await openLab(page);
    await runFirst(page, 'x = 41');
    await expect(codeCell(page).locator('[data-prompt]')).toHaveText('In [1]:');

    await viaControl(page, 'restart');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 15_000 });

    // The number stays -- the reader still sees this ran, and when -- but
    // it is struck through and labelled, because In [1] now describes a
    // Lua state that is gone.
    await expect(codeCell(page).locator('[data-prompt]')).toHaveText('In [1]:');
    await expect(codeCell(page)).toHaveAttribute('data-run-state', 'stale');
  });

  test('running again clears the stale mark', async ({ page }) => {
    await openLab(page);
    await runFirst(page, 'return 1');
    await viaControl(page, 'restart');
    await expect(codeCell(page)).toHaveAttribute('data-run-state', 'stale', { timeout: 15_000 });
    await runFirst(page, 'return 2');
    await expect(codeCell(page)).toHaveAttribute('data-run-state', 'ok');
  });

  test('a never-run cell is not marked stale by a restart', async ({ page }) => {
    await openLab(page);
    // markAllStale only touches cells that actually show a run; a blank
    // cell has no history to be stale.
    await viaControl(page, 'restart');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 15_000 });
    await expect(codeCell(page)).not.toHaveAttribute('data-run-state', 'stale');
  });
});

test.describe('folding', () => {
  test('folds and unfolds a cell, hiding its editor', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-action="fold"]').first().click();
    await expect(cell).toHaveAttribute('data-folded', 'true');
    await expect(cell.locator('[data-editor]')).toBeHidden();
    // A folded cell still says what it is: a one-line preview.
    await expect(cell.locator('.fold-preview')).toBeVisible();

    await cell.locator('[data-action="fold"]').first().click();
    await expect(cell).toHaveAttribute('data-folded', 'false');
    await expect(cell.locator('[data-editor]')).toBeVisible();
  });

  test('a fold survives a reload, because it is stored as nbformat metadata', async ({ page }) => {
    await openLab(page);
    await codeCell(page).locator('[data-action="fold"]').first().click();
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]');
    await dismissLauncher(page);
    await expect(codeCell(page)).toHaveAttribute('data-folded', 'true');
  });

  test('folding is written where JupyterLab reads it', async ({ page }) => {
    await openLab(page);
    await codeCell(page).locator('[data-action="fold"]').first().click();
    const i = await firstCodeIndex(page);
    const metadata = await page.evaluate((idx) => window.lab.model.cells[idx].metadata, i);
    expect(metadata.jupyter?.source_hidden).toBe(true);
  });
});

test.describe('execution timing', () => {
  test('a finished run shows how long it took', async ({ page }) => {
    await openLab(page);
    const cell = await runFirst(page, 'for i = 1, 100000 do end return "done"');
    const timing = cell.locator('[data-timing]');
    await expect(timing).toBeVisible();
    await expect(timing).toHaveText(/\d/);      // some number of ms or s
  });

  test('timing is stored as ExecuteTime metadata, so it round-trips', async ({ page }) => {
    await openLab(page);
    await runFirst(page, 'return 1');
    const i = await firstCodeIndex(page);
    const execution = await page.evaluate((idx) => window.lab.model.cells[idx].metadata.execution, i);
    // The exact keys JupyterLab's ExecuteTime extension writes and reads.
    expect(execution['iopub.execute_input']).toBeTruthy();
    expect(execution['shell.execute_reply']).toBeTruthy();
  });
});

test.describe('output height', () => {
  test('a tall output is capped and scrolls rather than pushing the page', async ({ page }) => {
    await openLab(page);
    const cell = await runFirst(page, 'for i = 1, 400 do print("line " .. i) end');
    const capped = await cell.locator('[data-outputs]').evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    // Bounded on screen, but all of it is still reachable by scrolling.
    expect(capped.clientHeight).toBeLessThan(capped.scrollHeight);
    expect(capped.clientHeight).toBeLessThan(500);
  });

  test('the fullscreen control is present on a code cell', async ({ page }) => {
    await openLab(page);
    // The API itself cannot be driven headless without a user gesture
    // Playwright honours inconsistently, so this asserts the affordance is
    // wired; the height cap is what makes it non-essential.
    await expect(codeCell(page).locator('[data-action="fullscreen"]')).toHaveCount(1);
  });
});

test.describe('the elapsed clock', () => {
  test('stops when the cell finishes', async ({ page }) => {
    // It did not. `updateOutputs` cleared `data-busy` and left the
    // interval running, so the final duration was written and then
    // overwritten 100ms later, for as long as the page stayed open --
    // `1 + 2` answered `3` instantly and went on counting. Nothing called
    // `setBusy(id, false)` on the success path, and nothing should have
    // to: having outputs is what finishing means.
    await openLab(page);
    const cell = await runFirst(page, '1 + 2');
    await expect(cell.locator('.output-execute_result pre')).toHaveText('3');

    const timing = cell.locator('[data-timing]');
    const settled = await timing.textContent();
    expect(settled).toMatch(/\d/);
    await page.waitForTimeout(900);
    expect(await timing.textContent()).toBe(settled);
  });

  test('and it still runs while a cell is running', async ({ page }) => {
    // The fix must not be "never start the clock". A cell that has been
    // going for eight seconds has to look different from one that just
    // started -- that is the difference between "be patient" and "press
    // Stop".
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('local t = 0 for i = 1, 40000000 do t = t + i end return t');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell).toHaveAttribute('data-busy', 'true');
    await expect(cell.locator('[data-timing]')).toBeVisible();
    await expect(cell).toHaveAttribute('data-busy', 'false', { timeout: 60_000 });
  });
});
