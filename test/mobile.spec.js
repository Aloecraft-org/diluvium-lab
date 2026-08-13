import { test, expect, devices } from '@playwright/test';
import { dismissLauncher } from './chrome.js';

// A phone is where "try the language with nothing installed" is worth the
// most, because installing anything there is worst. This runs the real
// page in a real phone viewport with touch input, and taps rather than
// typing keyboard shortcuts -- there is no Ctrl key to press.

test.use({ ...devices['Pixel 7'] });

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
  return problems;
}

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();

test.describe('on a phone', () => {
  test('the page does not scroll sideways', async ({ page }) => {
    await openLab(page);
    // Horizontal overflow is the single most obvious "this was never
    // opened on a phone" tell, and it is caused by one fixed width
    // somewhere that nobody notices on a desktop.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });

  test('a cell runs by tapping, with no keyboard involved', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return 6 * 7');
    await cell.locator('[data-action="run"]').tap();
    await expect(cell).toHaveAttribute('data-busy', 'false');
    await expect(cell.locator('[data-outputs]')).toContainText('42');
  });

  test('controls are big enough to hit', async ({ page }) => {
    await openLab(page);
    // 44 CSS px is the usual floor. These were about 24 before, which is
    // a miss more often than a hit.
    const tooSmall = await page.evaluate(() => [...document.querySelectorAll('.toolbar button')]
      .map((b) => ({ label: b.textContent.trim(), height: b.getBoundingClientRect().height }))
      .filter((b) => b.height < 44));
    expect(tooSmall).toEqual([]);
  });

  test('the editor is 16px, so focusing it does not zoom the page', async ({ page }) => {
    await openLab(page);
    // iOS zooms in on a focused field under 16px and does not zoom back
    // out. The overlay has to match exactly or the highlight drifts off
    // the glyphs -- these two numbers are one decision, not two.
    const fonts = await page.evaluate(() => ({
      textarea: getComputedStyle(document.querySelector('[data-editor]')).fontSize,
      highlight: getComputedStyle(document.querySelector('.editor-highlight')).fontSize,
    }));
    expect(fonts.textarea).toBe('16px');
    expect(fonts.highlight).toBe(fonts.textarea);
  });

  test('the cell toolbar is not hidden behind a hover that cannot happen', async ({ page }) => {
    await openLab(page);
    const opacity = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.cell-tools')).opacity);
    expect(Number(opacity)).toBe(1);
  });

  test('the overlay still lines up with the textarea at phone size', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill(
      'local wrapped = "a line long enough that it has to wrap on a narrow screen somewhere"');
    // The same invariant the desktop suite checks, re-checked here because
    // the phone rules change the font size that decides it.
    const metrics = await cell.evaluate((node) => {
      const ta = node.querySelector('[data-editor]');
      const pre = node.querySelector('.editor-highlight');
      const a = ta.getBoundingClientRect();
      const b = pre.getBoundingClientRect();
      return { dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
               sh: [ta.scrollHeight, pre.scrollHeight] };
    });
    expect(metrics.dx).toBeLessThan(0.5);
    expect(metrics.dy).toBeLessThan(0.5);
    expect(metrics.sh[0]).toBe(metrics.sh[1]);
  });

  test('the bytecode panel scrolls itself rather than the page', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('print("hello")');
    // On touch the per-cell buttons stay quiet; every action rides the
    // ⋯ menu, with a word for a label instead of a glyph.
    await cell.locator('.cell-more').tap();
    await page.locator('.menu-pop:not([hidden]) .menu-item', { hasText: 'Bytecode' }).tap();
    await expect(cell.locator('[data-bytecode]')).toBeVisible();
    // Wide by nature -- a disassembly table and a hex dump. Whatever it
    // does, it must not push the document sideways.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });
});

test.describe('the toolbar on a small screen', () => {
  test('takes one row, not half the screen', async ({ page }) => {
    await openLab(page);
    // Nine controls at 44px tall with `flex-wrap: wrap` stacked into four
    // or five rows before a single cell was visible. One scrolling row
    // keeps every control reachable and costs one row.
    const metrics = await page.evaluate(() => {
      const bar = document.querySelector('.toolbar').getBoundingClientRect();
      return {
        height: bar.height,
        share: bar.height / window.innerHeight,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(metrics.share).toBeLessThan(0.2);
    expect(metrics.overflow).toBe(0);          // it scrolls itself, not the page
  });

  test('and the menus are still reachable, through the hamburger', async ({ page }) => {
    await openLab(page);
    // The identity and menu rows fold away at this width; the hamburger
    // is the promise that nothing folded away is lost. About lives three
    // rows deep on a desktop and one tap deep here.
    await expect(page.locator('.masthead')).toBeHidden();
    await expect(page.locator('.menubar')).toBeHidden();
    await page.locator('[data-hamburger]').tap();
    await expect(page.locator('[data-drawer]')).toBeVisible();
    await page.locator('[data-drawer] [data-toolbar="about"]').tap();
    await expect(page.locator('[data-about]')).toBeVisible();
  });
});
