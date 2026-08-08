import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// The About panel exists for bug reports.
//
// "It does not work" is unactionable, and nobody should have to be talked
// through finding a version. So every value here is read from the thing it
// describes rather than assumed, and the panel hands over a block to
// paste. These tests check the facts are true, not merely present -- a
// version display that is confidently wrong is worse than none, because
// it sends the reader looking in the wrong build.

const LAB_VERSION = /export const LAB_VERSION = '([^']+)'/
  .exec(readFileSync(new URL('../src/version.js', import.meta.url), 'utf8'))[1];
const PINNED_TAG = readFileSync(new URL('../vendor/PINNED_TAG', import.meta.url), 'utf8').trim();
const PINNED_JS = readFileSync(new URL('../vendor/pinned.js', import.meta.url), 'utf8');
const PINNED_SHA = /sha256: '([0-9a-f]{64})'/.exec(PINNED_JS)[1];

async function openLab(page) {
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

const dialog = (page) => page.locator('[data-about]');
const openAbout = async (page) => {
  await page.locator('[data-toolbar="about"]').click();
  await expect(dialog(page)).toBeVisible();
};

test.describe('the About panel', () => {
  test('opens, and closes on Escape', async ({ page }) => {
    await openLab(page);
    await openAbout(page);
    // <dialog> gives Escape, focus containment and the top layer for free.
    // None of those are worth reimplementing, and all three are things a
    // hand-rolled div gets wrong.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  });

  test('states the Lab version', async ({ page }) => {
    await openLab(page);
    await openAbout(page);
    await expect(dialog(page)).toContainText(LAB_VERSION);
  });

  test('states which Diluvium is actually loaded, down to the checksum', async ({ page }) => {
    await openLab(page);
    await openAbout(page);
    const text = await dialog(page).innerText();

    // Checked against vendor/, not against itself. If someone re-pins the
    // runtime and forgets to regenerate vendor/pinned.js, this is what
    // notices -- which is the whole failure mode a version display has.
    expect(text).toContain(PINNED_TAG);
    expect(text).toContain(PINNED_SHA);
  });

  test('the version it shows is the one the kernel reports', async ({ page }) => {
    await openLab(page);
    await openAbout(page);
    // The strongest check available: ask the running kernel separately and
    // require the panel to agree. A number copied from a constant can
    // drift from the binary; this cannot.
    const reported = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return (await executeCollected(window.lab.kernel, 'return _VERSION')).result;
    });
    expect(reported).toBeTruthy();
    await expect(dialog(page)).toContainText(reported);
  });

  test('says whether the kernel is off-thread, because it changes what works', async ({ page }) => {
    await openLab(page);
    await openAbout(page);
    // Someone reporting "Stop does nothing" needs this line, and it is the
    // one fact about the Lab that varies by how the page was opened.
    await expect(dialog(page)).toContainText('worker');
  });

  test('carries a report block that holds the facts, not a summary', async ({ page }) => {
    await openLab(page);
    await openAbout(page);
    const report = await page.locator('[data-about-report]').innerText();
    for (const needle of [LAB_VERSION, PINNED_TAG, PINNED_SHA, 'Browser', 'Notebook format']) {
      expect(report, `report should mention ${needle}`).toContain(needle);
    }
  });

  test('copying puts the report on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLab(page);
    await openAbout(page);
    await page.locator('[data-about-action="copy"]').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(LAB_VERSION);
    expect(clip).toContain(PINNED_TAG);
  });

  test('a refused clipboard says so rather than failing silently', async ({ page }) => {
    await openLab(page);
    // Clipboard access is denied in plenty of ordinary situations, and the
    // text is on screen and selectable either way -- so the failure has to
    // point at that rather than look like nothing happened.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });
    });
    await openAbout(page);
    await page.locator('[data-about-action="copy"]').click();
    await expect(page.locator('[data-toast]')).toContainText('select the text');
  });

  test('follows a runtime switch rather than reporting the bundled one forever', async ({ page }) => {
    await openLab(page);
    // The panel reads whichever runtime is current. Reporting the bundled
    // build after switching would point every bug report at the wrong
    // binary -- the exact opposite of what this is for.
    await page.evaluate(() => {
      window.lab.runtimeId = 'v9.9.9_fake';
      window.lab.registry.remote = [{
        tag: 'v9.9.9_fake', version: '9.9.9', published: '2026-01-01T00:00:00Z',
        assets: { 'libdiluvium_wasi.wasm': 'f'.repeat(64) },
      }];
    });
    await openAbout(page);
    const text = await dialog(page).innerText();
    expect(text).toContain('v9.9.9_fake');
    expect(text).toContain('f'.repeat(64));
    expect(text).not.toContain(PINNED_SHA);
  });
});
