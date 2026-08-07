import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// `.ipynb` is the storage format -- a hard constraint, and the point of it
// is that files leave this app and still work. So these tests check the
// bytes on the way out, not just that a round trip inside the app agrees
// with itself.

async function openLab(page) {
  // Start each test from an empty database, but only on the *first* load of
  // the tab: init scripts also run on reload, and the autosave tests below
  // reload on purpose to prove the notebook comes back.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('lab-test-fresh')) return;
    sessionStorage.setItem('lab-test-fresh', '1');
    indexedDB.deleteDatabase('diluvium-lab');
  });
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return page;
}

const cells = (page) => page.locator('.cell');
const cell = (page, i) => cells(page).nth(i);

async function setNotebook(page, sources) {
  await page.evaluate((list) => {
    const app = window.lab;
    app.model.cells.length = 0;
    for (const [type, source] of list) {
      // setSource, not a direct assignment: going through the model is what
      // notifies the view and schedules the autosave, and a helper that
      // skips it would be testing a path the app never takes.
      const c = app.model.addCell(type);
      app.model.setSource(c.id, source);
    }
    app.view.render();
  }, sources);
}

async function upload(page, notebook, name = 'uploaded.ipynb') {
  await page.locator('[data-file-input]').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(typeof notebook === 'string' ? notebook : JSON.stringify(notebook)),
  });
}

async function download(page) {
  const [event] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-toolbar="save"]').click(),
  ]);
  const stream = await event.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { name: event.suggestedFilename(), json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

test.describe('saving', () => {
  test('produces a valid nbformat 4 notebook', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['markdown', '# Notes'], ['code', 'print("saved")']]);

    const { json } = await download(page);
    expect(json.nbformat).toBe(4);
    expect(json.nbformat_minor).toBe(5);
    expect(json.metadata.kernelspec.name).toBe('diluvium');
    expect(json.metadata.language_info.name).toBe('lua');
    expect(json.cells).toHaveLength(2);
    expect(json.cells[0].cell_type).toBe('markdown');
    // markdown cells carry no outputs or execution_count, per the schema
    expect(json.cells[0].outputs).toBeUndefined();
    expect(json.cells[0].execution_count).toBeUndefined();
    expect(json.cells[1].cell_type).toBe('code');
    expect(json.cells[1].outputs).toEqual([]);
  });

  test('stores source as an array of lines, the way Jupyter does', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['code', 'local a = 1\nlocal b = 2\nprint(a + b)']]);

    const { json } = await download(page);
    expect(json.cells[0].source).toEqual(['local a = 1\n', 'local b = 2\n', 'print(a + b)']);
  });

  test('saves outputs a cell actually produced', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['code', 'print("captured") return 7']]);
    await cell(page, 0).locator('[data-action="run"]').click();
    await expect(cell(page, 0).locator('[data-outputs] .output')).toHaveCount(2);

    const { json } = await download(page);
    const [stream, result] = json.cells[0].outputs;
    expect(stream).toMatchObject({ output_type: 'stream', name: 'stdout', text: ['captured\n'] });
    expect(result.output_type).toBe('execute_result');
    expect(result.data['text/plain']).toEqual(['7']);
    expect(json.cells[0].execution_count).toBe(1);
  });

  test('an error output is saved with ename, evalue and traceback', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['code', 'error("saved failure")']]);
    await cell(page, 0).locator('[data-action="run"]').click();
    await expect(cell(page, 0).locator('[data-output-type="error"]')).toHaveCount(1);

    const { json } = await download(page);
    const [output] = json.cells[0].outputs;
    expect(output.output_type).toBe('error');
    expect(output.ename).toBe('LuaError');
    expect(output.evalue).toContain('saved failure');
    expect(Array.isArray(output.traceback)).toBe(true);
  });
});

test.describe('opening', () => {
  test('replaces the notebook with the file', async ({ page }) => {
    await openLab(page);
    await upload(page, {
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# From a file'] },
        { cell_type: 'code', execution_count: 3, metadata: {}, outputs: [], source: ['print("from disk")'] },
      ],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    });

    await expect(cells(page)).toHaveCount(2);
    await expect(cell(page, 0)).toHaveAttribute('data-cell-type', 'markdown');
    await expect(cell(page, 1).locator('[data-editor]')).toHaveValue('print("from disk")');
    await expect(cell(page, 1).locator('[data-prompt]')).toHaveText('In [3]:');
    await expect(page.locator('[data-filename]')).toHaveText('uploaded.ipynb');
  });

  test('a notebook with saved outputs shows them without re-running', async ({ page }) => {
    await openLab(page);
    await upload(page, {
      cells: [{
        cell_type: 'code', execution_count: 1, metadata: {},
        source: ['print("was run earlier")'],
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['was run earlier\n'] }],
      }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    });
    await expect(cell(page, 0).locator('[data-outputs] .output')).toContainText('was run earlier');
  });

  test('the repository sample notebook opens and runs', async ({ page }) => {
    await openLab(page);
    const sample = await readFile(new URL('../notebooks/hello.ipynb', import.meta.url), 'utf8');
    await upload(page, sample, 'hello.ipynb');

    await expect(cells(page)).toHaveCount(4);
    await page.locator('[data-toolbar="run-all"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false');

    // The sample is written in 5.4.7 syntax on purpose; if it ever fails
    // here, it drifted into 5.5 constructs the pinned runtime cannot parse.
    await expect(page.locator('[data-output-type="error"]')).toHaveCount(0);
    await expect(cell(page, 1).locator('[data-outputs]')).toContainText('hello, world!');
  });

  test('rubbish is refused without breaking the page', async ({ page }) => {
    await openLab(page);
    const before = await cells(page).count();
    await upload(page, 'this is not json at all', 'bad.ipynb');

    await expect(page.locator('[data-toast]')).toBeVisible();
    await expect(page.locator('[data-toast]')).toHaveAttribute('data-kind', 'error');
    await expect(cells(page)).toHaveCount(before);

    // still usable
    await cell(page, 0).locator('[data-action="run"]').click();
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  });

  test('valid JSON that is not a notebook is refused too', async ({ page }) => {
    await openLab(page);
    await upload(page, { some: 'object' }, 'notanotebook.ipynb');
    await expect(page.locator('[data-toast]')).toContainText('notebook');
  });
});

test.describe('round trip', () => {
  test('save then open yields the same document', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [
      ['markdown', '# Round trip\n\nWith **emphasis**.'],
      ['code', 'print("one")\nprint("two")'],
      ['code', '21 * 2'],
    ]);
    await page.locator('[data-toolbar="run-all"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false');

    const { json } = await download(page);
    await upload(page, json, 'roundtrip.ipynb');

    await expect(cells(page)).toHaveCount(3);
    await expect(cell(page, 1).locator('[data-editor]')).toHaveValue('print("one")\nprint("two")');
    await expect(cell(page, 1).locator('[data-outputs]')).toContainText('one');
    await expect(cell(page, 2).locator('[data-outputs]')).toContainText('42');

    const again = await download(page);
    expect(again.json).toEqual(json);
  });
});

test.describe('autosave', () => {
  test('survives a reload', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['code', 'print("this should come back")']]);
    await page.evaluate(() => window.lab.autosave.flush());

    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });

    await expect(cells(page)).toHaveCount(1);
    await expect(cell(page, 0).locator('[data-editor]')).toHaveValue('print("this should come back")');
  });

  test('keeps outputs, so a reload does not lose a slow run', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['code', 'print("expensive result")']]);
    await cell(page, 0).locator('[data-action="run"]').click();
    await expect(cell(page, 0).locator('[data-outputs] .output')).toHaveCount(1);
    await page.evaluate(() => window.lab.autosave.flush());

    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await expect(cell(page, 0).locator('[data-outputs]')).toContainText('expensive result');
  });

  test('uses IndexedDB rather than localStorage', async ({ page }) => {
    await openLab(page);
    await setNotebook(page, [['code', 'print("stored")']]);
    await page.evaluate(() => window.lab.autosave.flush());

    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    const stored = await page.evaluate(async () => {
      const { loadAutosave } = await import('./src/notebook/storage.js');
      return (await loadAutosave())?.ipynb?.cells?.length ?? 0;
    });
    expect(stored).toBe(1);
  });

  test('a first visit gets the sample notebook, not a blank page', async ({ page }) => {
    await openLab(page);
    expect(await cells(page).count()).toBeGreaterThan(1);
    await expect(cell(page, 0)).toHaveAttribute('data-cell-type', 'markdown');
  });
});
