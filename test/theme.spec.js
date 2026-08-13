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

    // A preference, not a session setting. The pref write is
    // fire-and-forget; give IndexedDB its beat before the reload that
    // is meant to read it back.
    await page.waitForTimeout(400);
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

  // A dropdown's <option>s are painted by the platform, not the page, and
  // Chrome on Linux and Windows draws that surface light whatever
  // `color-scheme` says. The select is transparent so it sits in the
  // toolbar; without an explicit colour on the options the transparency
  // and the white `color: inherit` are what the popup gets, and a dark
  // theme's runtime dropdown comes out white-on-white -- readable only by
  // the one highlighted row. So: every option names both colours, in both
  // themes, and they contrast.
  test('an open dropdown is legible in both themes, not white on white',
    async ({ page }) => {
      await openLab(page);

      for (const theme of ['dark', 'light']) {
        await viaControl(page, `theme-${theme}`);
        const opts = await page.evaluate(() =>
          [...document.querySelectorAll('select')]
            .filter((s) => s.offsetParent !== null)
            .flatMap((s) => [...s.options].map((o) => {
              const cs = getComputedStyle(o);
              return { color: cs.color, background: cs.backgroundColor };
            })));

        expect(opts.length).toBeGreaterThan(0);
        for (const o of opts) {
          // Neither may be transparent: a transparent option is one that
          // takes whatever the platform painted underneath it.
          expect(o.background, `${theme}: option background`).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
          const lum = (c) => {
            const [r, g, b] = c.match(/\d+/g).map(Number);
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          };
          // Not a full WCAG figure -- just that the two are not the same
          // surface, which is the bug this guards.
          expect(Math.abs(lum(o.color) - lum(o.background)),
            `${theme}: option contrast`).toBeGreaterThan(0.4);
        }
      }
    });
});
