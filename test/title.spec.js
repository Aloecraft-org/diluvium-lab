import { test, expect } from '@playwright/test';
import { dismissLauncher } from './chrome.js';

// The notebook's name, which is not its filename.
//
// nbformat has no field for this -- Jupyter uses the filename and has
// nothing else -- so it lives in `metadata.title`, which is what makes it
// survive a save, a reopen and a round trip through any other tool that
// preserves notebook metadata.

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

const title = (page) => page.locator('[data-nb-title]');
const field = (page) => page.locator('[data-nb-title-input]');

async function rename(page, to, key = 'Enter') {
  await title(page).click();
  await field(page).fill(to);
  await field(page).press(key);
}

const metadataOf = (page) => page.evaluate(async () => {
  const { toIpynb } = await import('./src/notebook/ipynb.js');
  return toIpynb(window.lab.model).metadata;
});

test.describe('naming a notebook', () => {
  test('starts untitled, and says so rather than leaving a gap', async ({ page }) => {
    await openLab(page);
    await expect(title(page)).toHaveText('Untitled notebook');
    await expect(title(page)).toHaveAttribute('data-untitled', 'true');
    // Nothing is written for a notebook nobody has named.
    expect((await metadataOf(page)).title).toBeUndefined();
  });

  test('click to rename, and the tab says so too', async ({ page }) => {
    await openLab(page);
    await rename(page, 'Rainfall analysis');

    await expect(title(page)).toHaveText('Rainfall analysis');
    await expect(title(page)).toHaveAttribute('data-untitled', 'false');
    // Someone with four Labs open is choosing between them by tab title.
    await expect(page).toHaveTitle('Rainfall analysis — Diluvium Lab');
    expect((await metadataOf(page)).title).toBe('Rainfall analysis');
  });

  test('is independent of the filename', async ({ page }) => {
    await openLab(page);
    await rename(page, 'Something else entirely');
    // The point of the request: these are two different names for two
    // different jobs, and renaming one must not touch the other.
    await expect(page.locator('[data-filename]')).toHaveText('notebook.ipynb');
  });

  test('Escape restores the old name', async ({ page }) => {
    await openLab(page);
    await rename(page, 'Kept');
    await rename(page, 'Discarded', 'Escape');
    await expect(title(page)).toHaveText('Kept');
    expect((await metadataOf(page)).title).toBe('Kept');
  });

  test('clearing it makes the notebook untitled again', async ({ page }) => {
    await openLab(page);
    await rename(page, 'Temporary');
    await rename(page, '   ');
    await expect(title(page)).toHaveText('Untitled notebook');
    // Cleared rather than stored as "", so an untitled notebook does not
    // carry an empty title around forever.
    expect((await metadataOf(page)).title).toBeUndefined();
  });

  test('survives a reload', async ({ page }) => {
    await openLab(page);
    await rename(page, 'Persisted');
    await page.waitForTimeout(600);          // the autosave debounce
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(title(page)).toHaveText('Persisted');
  });

  test('and a save and reopen, because it is in the file', async ({ page }) => {
    await openLab(page);
    await rename(page, 'Round tripped');
    const saved = await page.evaluate(async () => {
      const { toIpynb } = await import('./src/notebook/ipynb.js');
      return JSON.stringify(toIpynb(window.lab.model));
    });
    await page.evaluate(async (json) => {
      const { fromIpynb } = await import('./src/notebook/ipynb.js');
      window.lab._setModel(fromIpynb(json));
    }, saved);
    await expect(title(page)).toHaveText('Round tripped');
  });
});

test.describe('notebook metadata', () => {
  test('is carried through rather than dropped', async ({ page }) => {
    await openLab(page);
    // `fromIpynb` built a model with no metadata at all, so every notebook
    // opened here was quietly stripped of its notebook-level fields on the
    // way back out. A title stored there could not have survived either.
    await page.evaluate(async () => {
      const { fromIpynb } = await import('./src/notebook/ipynb.js');
      window.lab._setModel(fromIpynb(JSON.stringify({
        cells: [], nbformat: 4, nbformat_minor: 5,
        metadata: { title: 'From a file', authors: [{ name: 'Someone' }], custom: { keep: 1 } },
      })));
    });
    await expect(title(page)).toHaveText('From a file');
    const metadata = await metadataOf(page);
    expect(metadata.authors).toEqual([{ name: 'Someone' }]);
    expect(metadata.custom).toEqual({ keep: 1 });
    // The Lab's kernelspec still wins: whatever wrote this file, *this* is
    // what would run it.
    expect(metadata.kernelspec.name).toBe('diluvium');
  });

  test('a Colab notebook arrives with the name it had', async ({ page }) => {
    await openLab(page);
    await page.evaluate(async () => {
      const { fromIpynb } = await import('./src/notebook/ipynb.js');
      window.lab._setModel(fromIpynb(JSON.stringify({
        cells: [], nbformat: 4, nbformat_minor: 5,
        metadata: { colab: { name: 'Shared with me.ipynb', provenance: [] } },
      })));
    });
    await expect(title(page)).toHaveText('Shared with me');

    // And renaming it wins, rather than being undone by Colab's copy on
    // the next read.
    await rename(page, 'Mine now');
    await expect(title(page)).toHaveText('Mine now');
    const metadata = await metadataOf(page);
    expect(metadata.title).toBe('Mine now');
    expect(metadata.colab.name).toBeUndefined();
    expect(metadata.colab.provenance).toEqual([]);
  });
});
