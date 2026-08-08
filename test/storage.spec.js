import { test, expect } from '@playwright/test';

// Persistence, and the ways it realistically fails.
//
// Nobody loses a notebook to an exotic bug. They lose it by closing a tab
// a moment after typing, by a phone backgrounding the page, or by opening
// the Lab in a browser where IndexedDB is switched off and finding out
// only afterwards. These are those cases, driven through the real page
// against real IndexedDB.
//
// Deliberately not exhaustive -- this is the cheap safety net, not a
// storage test suite. The gaps it leaves are named in ROADMAP.md.

// Note the absence of `addInitScript` here, which every other spec uses to
// wipe IndexedDB. It runs again on *every* navigation, including
// `page.reload()` -- so in a suite whose whole subject is surviving a
// reload it would delete the thing under test and every case would fail
// for the wrong reason. It did, first time round. Clear once, explicitly,
// through the Lab's own storage module instead.
async function openLab(page, { keepData = false } = {}) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  if (!keepData) {
    await page.evaluate(async () => {
      const { clearAutosave } = await import('./src/notebook/storage.js');
      await clearAutosave();
    });
    await reload(page);
  }
  return problems;
}

/** Reload without wiping the database, which is the whole point here. */
async function reload(page) {
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();
const MARKER = 'local survives_a_reload = true';

test.describe('a notebook survives', () => {
  test('typing, then a reload', async ({ page }) => {
    await openLab(page);
    await codeCell(page).locator('[data-editor]').fill(MARKER);
    // Longer than the 400ms autosave debounce.
    await page.waitForTimeout(600);
    await reload(page);
    await expect(codeCell(page).locator('[data-editor]')).toHaveValue(MARKER);
  });

  test('a reload immediately after typing, with no time to debounce', async ({ page }) => {
    await openLab(page);
    await codeCell(page).locator('[data-editor]').fill(MARKER);
    // The gap the debounce leaves: without a flush on the way out, the
    // last thing typed is the one thing lost. `visibilitychange` is what
    // a phone fires when a tab is backgrounded, and it may be the last
    // event the page ever sees.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await reload(page);
    await expect(codeCell(page).locator('[data-editor]')).toHaveValue(MARKER);
  });

  test('outputs and execution counts, not just source', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('print("output that should come back")');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell).toHaveAttribute('data-busy', 'false');
    await page.waitForTimeout(600);          // let the autosave debounce land

    await reload(page);
    // A notebook that restores its code but loses what it produced is a
    // notebook you have to run again to read, which for a slow cell is
    // the same as losing it.
    await expect(codeCell(page).locator('[data-outputs]')).toContainText('output that should come back');
    await expect(codeCell(page).locator('.prompt')).toContainText('[1]');
  });

  test('the filename, so Save writes back to the same name', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => { window.lab.filename = 'renamed.ipynb'; window.lab._scheduleAutosave(); });
    await page.waitForTimeout(600);
    await reload(page);
    await expect(page.locator('[data-filename]')).toContainText('renamed.ipynb');
  });

  test('adding and deleting cells', async ({ page }) => {
    await openLab(page);
    const before = await page.locator('.cell').count();
    await page.locator('[data-toolbar="add-code"]').click();
    await page.locator('.cell').last().locator('[data-editor]').fill('-- the added cell');
    await page.waitForTimeout(600);

    await reload(page);
    await expect(page.locator('.cell')).toHaveCount(before + 1);
    await expect(page.locator('.cell').last().locator('[data-editor]')).toHaveValue('-- the added cell');
  });
});

test.describe('when storage misbehaves', () => {
  test('a corrupt autosave record does not take the page with it', async ({ page }) => {
    await openLab(page);
    // Half-written records happen: a tab killed mid-write, a quota error,
    // a schema that moved. The Lab must open on the default notebook and
    // say nothing alarming rather than showing a blank page.
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('diluvium-lab', 2);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve) => {
        const tx = db.transaction('notebooks', 'readwrite');
        tx.objectStore('notebooks').put({ ipynb: { cells: 'not an array' } }, 'autosave');
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    });

    const problems = await openLab(page, { keepData: true });
    await expect(page.locator('.cell').first()).toBeVisible();
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    expect(problems).toEqual([]);

    // And it still runs, which is the part that matters.
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return 6 * 7');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell.locator('[data-outputs]')).toContainText('42');
  });

  test('IndexedDB being unavailable costs persistence and nothing else', async ({ page }) => {
    // Private browsing, a locked-down profile, a policy. The Lab should
    // still open and still run code -- it just will not remember. Failing
    // to start here would turn a preference into a broken product.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        get() { throw new Error('IndexedDB is disabled'); },
      });
    });
    await page.goto('/');
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });

    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return "still works"');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell.locator('[data-outputs]')).toContainText('still works');
  });

  test('a failed write does not stop the notebook being edited', async ({ page }) => {
    await openLab(page);
    // Quota exceeded is the realistic version of this. The edit is lost
    // on reload -- there is nowhere to put it -- but the session must
    // carry on rather than throwing on every keystroke.
    await page.evaluate(() => {
      window.lab.autosave.schedule = () => { throw new Error('quota exceeded'); };
    });
    const cell = codeCell(page);
    // The throw happens inside the model's change handler, so this is
    // really asking whether one failing listener breaks the editor.
    await cell.locator('[data-editor]').fill('typed after storage broke').catch(() => {});
    await expect(cell.locator('[data-editor]')).toHaveValue('typed after storage broke');
  });
});
