import { test, expect } from '@playwright/test';
import { dismissLauncher } from './chrome.js';
import { readFile, readdir } from 'node:fs/promises';

// The **Start here** gallery.
//
// These notebooks are the answer to "how do I do X in Diluvium", so two
// things have to hold that no amount of proofreading gets you: they are
// really bundled into the page (not fetched from `notebooks/`, which the
// baked single-file build does not have), and they really run on the
// pinned kernel. Both are checked here against the real page and the real
// kernel.

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

const gallery = (page) => page.locator('dialog[data-examples]');
const entries = (page) => page.locator('.example-entry');

async function openGallery(page) {
  await page.locator('[data-toolbar="examples"]').click();
  await expect(gallery(page)).toBeVisible();
}

// The bundle, read out of the page rather than off disk, so the assertions
// below are about what a reader actually gets.
const bundled = (page) => page.evaluate(async () => {
  const { EXAMPLES } = await import('./src/notebook/examples.js');
  return EXAMPLES.map(({ id, file, title, summary, cells }) => ({ id, file, title, summary, cells }));
});

test.describe('start here', () => {
  test('the button opens a gallery listing every bundled notebook', async ({ page }) => {
    await openLab(page);
    await expect(page.locator('[data-toolbar="examples"]')).toBeVisible();
    await openGallery(page);

    const list = await bundled(page);
    expect(list.length).toBeGreaterThan(0);
    await expect(entries(page)).toHaveCount(list.length);

    // Every entry says what it is. A gallery of bare filenames would not
    // be worth opening.
    for (const [i, example] of list.entries()) {
      const entry = entries(page).nth(i);
      await expect(entry).toHaveAttribute('data-example-open', example.id);
      await expect(entry.locator('.example-title')).toHaveText(example.title);
      await expect(entry.locator('.example-summary')).toHaveText(example.summary);
      expect(example.summary.length).toBeGreaterThan(20);
    }

    await page.locator('[data-examples-close]').click();
    await expect(gallery(page)).toBeHidden();
  });

  test('opening one replaces the notebook and takes its name from its own metadata', async ({ page }) => {
    await openLab(page);
    await openGallery(page);

    const [first] = await bundled(page);
    await entries(page).first().click();
    await expect(gallery(page)).toBeHidden();

    await expect(page.locator('.cell')).toHaveCount(first.cells);
    await expect(page.locator('[data-nb-title]')).toHaveText(first.title);
    await expect(page.locator('[data-nb-title]')).toHaveAttribute('data-untitled', 'false');
  });

  test('an opened example lands in recents like any other notebook', async ({ page }) => {
    await openLab(page);
    await openGallery(page);
    await entries(page).first().click();
    await expect(page.locator('[data-nb-title]')).not.toHaveText('Untitled notebook');

    const recent = await page.evaluate(async () => {
      const { listRecent } = await import('./src/notebook/storage.js');
      return (await listRecent()).map((entry) => entry.name);
    });
    expect(recent).toContain('hello.ipynb');
  });

  test('switching examples replaces rather than appends', async ({ page }) => {
    await openLab(page);
    const list = await bundled(page);
    expect(list.length).toBeGreaterThan(1);

    await openGallery(page);
    await entries(page).first().click();
    await expect(page.locator('.cell')).toHaveCount(list[0].cells);

    await openGallery(page);
    await entries(page).nth(1).click();
    await expect(page.locator('.cell')).toHaveCount(list[1].cells);
    await expect(page.locator('[data-nb-title]')).toHaveText(list[1].title);
  });

  test('the bundle is in step with notebooks/ on disk', async ({ page }) => {
    // `npm run release` runs bundle-examples --check for this reason, but a
    // stale bundle ships a notebook nobody edited, so it is worth failing
    // here too rather than only in the release script.
    await openLab(page);
    const list = await page.evaluate(async () => {
      const { EXAMPLES } = await import('./src/notebook/examples.js');
      return EXAMPLES.map(({ file, source }) => ({ file, source }));
    });

    const onDisk = (await readdir(new URL('../notebooks/', import.meta.url)))
      .filter((name) => name.endsWith('.ipynb'))
      .sort();
    expect(list.map((e) => e.file).sort()).toEqual(onDisk);

    for (const example of list) {
      const disk = await readFile(new URL(`../notebooks/${example.file}`, import.meta.url), 'utf8');
      expect(JSON.parse(example.source), `${example.file} is stale in the bundle`)
        .toEqual(JSON.parse(disk));
    }
  });
});

// One test per notebook: run every cell in order and insist that exactly
// the cells whose author said they would fail are the ones that did.
//
// These are teaching notebooks; a reader copying a cell that does not run
// is worse than no example at all. Cell by cell rather than **Run all**,
// which stops at the first error and would leave everything after a
// deliberate one unchecked -- which in `hello.ipynb` is most of it.
// Written as separate tests so a failure names the notebook.
const IDS = ['hello', 'language', 'secure-functions', 'messaging', 'sandbox', 'showing-things', 'browser-check'];

const plan = (page) => page.evaluate(async () => {
  const { expectationOf } = await import('./src/notebook/model.js');
  return window.lab.model.cells.map((cell) => ({
    code: cell.cell_type === 'code' && cell.source.trim() !== '',
    expect: expectationOf(cell),
  }));
});

test.describe('the examples actually run', () => {
  for (const id of IDS) {
    test(`${id}.ipynb runs as advertised on the pinned kernel`, async ({ page }) => {
      test.setTimeout(300_000);
      await openLab(page);
      await page.evaluate((exampleId) => window.lab.openExample(exampleId), id);
      await expect(page.locator('.cell').first()).toBeVisible();

      const cells = page.locator('.cell');
      const unexpected = [];
      const shouldHaveFailed = [];

      for (const [i, step] of (await plan(page)).entries()) {
        if (!step.code || step.expect === 'never-returns') continue;
        const cell = cells.nth(i);
        await cell.locator('[data-action="run"]').click();
        await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });

        const errors = cell.locator('[data-output-type="error"]');
        const failed = (await errors.count()) > 0;
        if (failed && step.expect !== 'error') {
          unexpected.push(`cell ${i}: ${(await errors.allInnerTexts()).join(' / ').split('\n')[0]}`);
        }
        // A cell that promised to fail and did not is a lesson that stopped
        // being true, which is worth catching just as much.
        if (!failed && step.expect === 'error') shouldHaveFailed.push(`cell ${i}`);
      }

      expect(unexpected, `${id}.ipynb errored where it did not say it would`).toEqual([]);
      expect(shouldHaveFailed, `${id}.ipynb has expect:error cells that ran clean`).toEqual([]);
    });
  }
});

test.describe('cells that misbehave on purpose', () => {
  test('Run all steps over a never-returning cell and says so', async ({ page }) => {
    await openLab(page);
    // browser-check ends in `while true do end`, deliberately. Without the
    // marker this hangs the kernel and Run all never finishes.
    await page.evaluate(() => window.lab.openExample('browser-check'));
    await expect(page.locator('.cell').first()).toBeVisible();

    await page.locator('[data-toolbar="run-all"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false', { timeout: 240_000 });
    await expect(page.locator('[data-toast]')).toContainText('never returns on purpose');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  });

  test('the cell says what it will do before you press anything', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('hello'));
    await expect(page.locator('.cell').first()).toBeVisible();

    const badge = page.locator('.cell').nth(9).locator('.expect-badge');
    await expect(badge).toHaveAttribute('data-expect', 'error');
    await expect(badge).toHaveText('errors on purpose');
    // Ordinary cells carry nothing.
    await expect(page.locator('.cell').nth(1).locator('.expect-badge')).toHaveCount(0);
  });

  test('running a never-returning cell yourself still runs it', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('browser-check'));
    const forever = page.locator('.cell').nth(20);
    await expect(forever.locator('.expect-badge')).toHaveAttribute('data-expect', 'never-returns');

    await forever.locator('[data-action="run"]').click();
    await expect(page.locator('[data-kernel-status]')).toHaveText('busy');
    await page.locator('[data-toolbar="stop"]').click();
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 30_000 });
  });
});
