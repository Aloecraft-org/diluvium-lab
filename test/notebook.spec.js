import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// The notebook, driven through the real page and the real buttons.
// Nothing is mocked -- every `Run` here goes to the WASM kernel.

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  // Start from a clean slate: autosave restores across reloads by design,
  // which would otherwise leak state between tests.
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
  await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  return problems;
}

const cells = (page) => page.locator('.cell');
const cell = (page, i) => cells(page).nth(i);
const editorOf = (node) => node.locator('[data-editor]');
const outputsOf = (node) => node.locator('[data-outputs] .output');

/** Replace a cell's source and run it, the way a person would. */
async function typeAndRun(page, index, source) {
  const node = cell(page, index);
  const editor = editorOf(node);
  await editor.fill(source);
  await editor.press('Control+Enter');
  await expect(node).toHaveAttribute('data-busy', 'false');
  return node;
}

/** Add a fresh code cell at the end and return its index. */
async function addCodeCell(page) {
  const before = await cells(page).count();
  await viaControl(page, 'add-code');
  await expect(cells(page)).toHaveCount(before + 1);
  return before;
}

test.describe('running cells', () => {
  test('a code cell runs and shows its output', async ({ page }) => {
    const problems = await openLab(page);
    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, 'print("hello from a cell")');

    await expect(outputsOf(node)).toHaveCount(1);
    await expect(outputsOf(node).first()).toHaveAttribute('data-output-type', 'stream');
    await expect(outputsOf(node).first()).toContainText('hello from a cell');
    await expect(node.locator('[data-prompt]')).toHaveText('In [1]:');
    expect(problems).toEqual([]);
  });

  test('an expression cell echoes its value', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, '6 * 7');

    const output = outputsOf(node).first();
    await expect(output).toHaveAttribute('data-output-type', 'execute_result');
    await expect(output).toContainText('42');
    await expect(output).toContainText('Out[1]:');
  });

  test('state carries between cells', async ({ page }) => {
    await openLab(page);
    const a = await addCodeCell(page);
    await typeAndRun(page, a, 'shared = "carried"');
    const b = await addCodeCell(page);
    const node = await typeAndRun(page, b, 'print(shared)');
    await expect(outputsOf(node).first()).toContainText('carried');
  });

  test('an error renders as an error, with its traceback', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, 'error("cell failed")');

    const output = outputsOf(node).first();
    await expect(output).toHaveAttribute('data-output-type', 'error');
    await expect(output.locator('[data-error-name]')).toContainText('cell failed');
    await expect(output.locator('.traceback')).toContainText('stack traceback');
  });

  test('Shift+Enter runs and moves to the next cell', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = cell(page, index);
    await editorOf(node).fill('print("advance")');
    await editorOf(node).press('Shift+Enter');
    await expect(node).toHaveAttribute('data-busy', 'false');

    // Focus landed on a following cell, creating one if there wasn't one.
    const focusedIndex = await page.evaluate(
      () => document.activeElement?.closest('[data-index]')?.dataset.index);
    expect(Number(focusedIndex)).toBeGreaterThan(index);
  });

  test('execution counts advance across cells', async ({ page }) => {
    await openLab(page);
    const a = await addCodeCell(page);
    await typeAndRun(page, a, 'print(1)');
    const b = await addCodeCell(page);
    await typeAndRun(page, b, 'print(2)');
    await expect(cell(page, a).locator('[data-prompt]')).toHaveText('In [1]:');
    await expect(cell(page, b).locator('[data-prompt]')).toHaveText('In [2]:');
  });
});

test.describe('run all', () => {
  test('runs every code cell in order', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => {
      const app = window.lab;
      app.model.cells.length = 0;
      app.model.addCell('code');
      app.model.addCell('code');
      app.model.addCell('code');
      app.model.setSource(app.model.cells[0].id, 'order = {}');
      app.model.setSource(app.model.cells[1].id, 'order[#order + 1] = "second"');
      app.model.setSource(app.model.cells[2].id, 'order[#order + 1] = "third" print(table.concat(order, ","))');
      app.view.render();
    });

    await page.locator('[data-toolbar="run-all"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false');
    await expect(outputsOf(cell(page, 2)).first()).toContainText('second,third');
  });

  test('stops at the first error rather than cascading', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => {
      const app = window.lab;
      app.model.cells.length = 0;
      app.model.addCell('code');
      app.model.addCell('code');
      app.model.addCell('code');
      app.model.setSource(app.model.cells[0].id, 'print("ran")');
      app.model.setSource(app.model.cells[1].id, 'error("stop here")');
      app.model.setSource(app.model.cells[2].id, 'print("should not run")');
      app.view.render();
    });

    await page.locator('[data-toolbar="run-all"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false');

    await expect(outputsOf(cell(page, 0)).first()).toContainText('ran');
    await expect(outputsOf(cell(page, 1)).first()).toHaveAttribute('data-output-type', 'error');
    await expect(outputsOf(cell(page, 2))).toHaveCount(0);
  });
});

test.describe('editing structure', () => {
  test('cells can be added, moved and deleted', async ({ page }) => {
    await openLab(page);
    const before = await cells(page).count();

    await viaControl(page, 'add-code');
    await expect(cells(page)).toHaveCount(before + 1);

    const last = cell(page, before);
    await editorOf(last).fill('-- marker');

    await last.locator('[data-action="move-up"]').click();
    await expect(editorOf(cell(page, before - 1))).toHaveValue('-- marker');

    await cell(page, before - 1).locator('[data-action="delete"]').click();
    await expect(cells(page)).toHaveCount(before);
  });

  test('deleting the last cell leaves a usable notebook', async ({ page }) => {
    await openLab(page);
    const count = await cells(page).count();
    for (let i = 0; i < count; i++) {
      await cell(page, 0).locator('[data-action="delete"]').click();
    }
    await expect(cells(page)).toHaveCount(1);
    await expect(cell(page, 0)).toHaveAttribute('data-cell-type', 'code');
  });

  test('a cell can be switched between code and markdown', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = cell(page, index);
    await editorOf(node).fill('# a heading');

    await node.locator('[data-action="to-markdown"]').click();
    await expect(cell(page, index)).toHaveAttribute('data-cell-type', 'markdown');

    await cell(page, index).locator('[data-action="to-code"]').click();
    await expect(cell(page, index)).toHaveAttribute('data-cell-type', 'code');
    await expect(editorOf(cell(page, index))).toHaveValue('# a heading');
  });
});

test.describe('markdown cells', () => {
  test('render on run and edit on double click', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'add-markdown');
    // + Cell inserts after the focused cell and selects it, so the new
    // markdown cell is the selected one, wherever it landed.
    const node = page.locator('.cell[data-selected="true"]');
    const index = Number(await node.getAttribute('data-index'));

    await editorOf(node).fill('# Title\n\nSome **bold** text and `code`.');
    await editorOf(node).press('Control+Enter');

    const rendered = cell(page, index).locator('[data-rendered]');
    await expect(rendered.locator('h1')).toHaveText('Title');
    await expect(rendered.locator('strong')).toHaveText('bold');
    await expect(rendered.locator('code')).toHaveText('code');
    await expect(editorOf(cell(page, index))).toBeHidden();

    await rendered.dblclick();
    await expect(editorOf(cell(page, index))).toBeVisible();
  });

  test('markdown cannot smuggle HTML in from a file', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'add-markdown');
    // + Cell inserts after the focused cell and selects it, so the new
    // markdown cell is the selected one, wherever it landed.
    const node = page.locator('.cell[data-selected="true"]');
    const index = Number(await node.getAttribute('data-index'));

    await editorOf(node).fill('<img src=x onerror="window.__pwned = true"> and [link](javascript:alert(1))');
    await editorOf(node).press('Control+Enter');

    const rendered = cell(page, index).locator('[data-rendered]');
    await expect(rendered.locator('img')).toHaveCount(0);
    await expect(rendered.locator('a')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});

test.describe('kernel controls', () => {
  test('restart discards state and marks the old runs stale', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    await typeAndRun(page, index, 'gone_after_restart = "here"');
    await expect(cell(page, index).locator('[data-prompt]')).toHaveText('In [1]:');

    await viaControl(page, 'restart');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    // The number is kept, not blanked -- the reader still sees that this
    // ran and in what order. It is marked stale, because In [1] now
    // describes a Lua state that no longer exists. Blanking to In [ ]
    // would erase that history, which is the Jupyter behaviour every
    // teacher warns about.
    await expect(cell(page, index).locator('[data-prompt]')).toHaveText('In [1]:');
    await expect(cell(page, index)).toHaveAttribute('data-run-state', 'stale');

    // And the kernel really is fresh: the variable is gone, and running
    // again clears the stale mark.
    const check = await addCodeCell(page);
    const node = await typeAndRun(page, check, 'print(tostring(gone_after_restart))');
    await expect(outputsOf(node).first()).toContainText('nil');
    await expect(node.locator('[data-prompt]')).toHaveText('In [1]:');
    await expect(node).toHaveAttribute('data-run-state', 'ok');
  });

  test('clear outputs empties every cell', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, 'print("something")');
    await expect(outputsOf(node)).toHaveCount(1);

    await viaControl(page, 'clear-outputs');
    await expect(outputsOf(cell(page, index))).toHaveCount(0);
  });
});

test.describe('the console shares the kernel', () => {
  const consoleInput = (page) => page.locator('[data-console-input]');
  const consoleLog = (page) => page.locator('[data-console-log]');

  test('a console expression sees variables the notebook defined', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    await typeAndRun(page, index, 'from_notebook = 99');

    await consoleInput(page).fill('from_notebook + 1');
    await consoleInput(page).press('Enter');
    await expect(consoleLog(page).locator('[data-console-result]')).toHaveText('100');
  });

  test('and the notebook sees what the console defined', async ({ page }) => {
    await openLab(page);
    await consoleInput(page).fill('from_console = "yes"');
    await consoleInput(page).press('Enter');
    await expect(consoleLog(page).locator('[data-console-input-echo]')).toHaveCount(1);

    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, 'print(from_console)');
    await expect(outputsOf(node).first()).toContainText('yes');
  });

  test('Enter on an unfinished line adds a line instead of running', async ({ page }) => {
    await openLab(page);
    await consoleInput(page).fill('for i = 1, 2 do');
    await consoleInput(page).press('Enter');

    // Nothing ran; the box grew instead.
    await expect(consoleLog(page).locator('[data-console-input-echo]')).toHaveCount(0);
    await expect(consoleInput(page)).toHaveValue('for i = 1, 2 do\n');

    await consoleInput(page).fill('for i = 1, 2 do\n  print("line", i)\nend');
    await consoleInput(page).press('Enter');
    await expect(consoleLog(page).locator('[data-console-stream="stdout"]')).toContainText('line\t1');
  });

  test('console errors are reported without killing the kernel', async ({ page }) => {
    await openLab(page);
    await consoleInput(page).fill('error("console boom")');
    await consoleInput(page).press('Enter');
    await expect(consoleLog(page).locator('[data-console-error]')).toContainText('console boom');

    await consoleInput(page).fill('print("still fine")');
    await consoleInput(page).press('Enter');
    await expect(consoleLog(page).locator('[data-console-stream="stdout"]')).toContainText('still fine');
  });
});

test.describe('output caps', () => {
  test('a long output is trimmed with a way to see all of it', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, 'for i = 1, 5000 do print("line " .. i) end');

    const output = outputsOf(node).first();
    const shown = await output.locator('pre').innerText();
    expect(shown.split('\n').length).toBeLessThan(300);
    expect(shown).toContain('line 1');
    expect(shown).not.toContain('line 5000');

    const showAll = output.locator('[data-action="show-all"]');
    await expect(showAll).toContainText('5,000');
    await showAll.click();

    const full = await outputsOf(cell(page, index)).first().locator('pre').innerText();
    expect(full).toContain('line 5000');
    await expect(outputsOf(cell(page, index)).first().locator('[data-action="show-less"]')).toBeVisible();
  });

  test('a short output has no show-all button', async ({ page }) => {
    await openLab(page);
    const index = await addCodeCell(page);
    const node = await typeAndRun(page, index, 'print("short")');
    await expect(node.locator('[data-action="show-all"]')).toHaveCount(0);
  });
});
