import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// The theme, forced or inherited.
//
// The page is drawn from system colours and light-dark() pairs, so the
// whole theme rides on `color-scheme` -- and the View menu's three items
// pin it or hand it back to the OS. What is tested is the mechanism (the
// attribute and the computed color-scheme), not pixels: if those are
// right, every colour on the page follows by construction.

async function openLab(page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
}

const colorScheme = (page) => page.evaluate(
  () => getComputedStyle(document.documentElement).colorScheme);

test.describe('the theme', () => {
  test('dark can be forced, survives a reload, and system hands back', async ({ page }) => {
    await openLab(page);
    // The default: no attribute, both schemes offered, the OS picks.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    expect(await colorScheme(page)).toContain('light');
    expect(await colorScheme(page)).toContain('dark');

    await viaControl(page, 'theme-dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await colorScheme(page)).toBe('dark');

    // A preference, not a session setting.
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await viaControl(page, 'theme-system');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  });

  test('forcing light wins over an OS that prefers dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openLab(page);

    await viaControl(page, 'theme-light');
    expect(await colorScheme(page)).toBe('light');
    // CanvasText now resolves for a light surface: the page's text is
    // dark. (The body's *background* is transparent -- the browser paints
    // Canvas at the root -- so the text colour is the readable signal.)
    const fg = await page.evaluate(() => getComputedStyle(document.body).color);
    const [r, g, b] = fg.match(/\d+/g).map(Number);
    expect((r + g + b) / 3).toBeLessThan(128);
  });

  test('the syntax colours follow a forced theme, not only the OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openLab(page);
    const keywordColor = () => page.evaluate(() => {
      const tok = document.querySelector('.tok-keyword');
      return tok ? getComputedStyle(tok).color : null;
    });
    const light = await keywordColor();
    expect(light).not.toBeNull();

    await viaControl(page, 'theme-dark');
    const dark = await keywordColor();
    expect(dark).not.toBeNull();
    expect(dark).not.toBe(light);
  });
});
