import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// The three-row chrome: identity masthead, menu bar, action toolbar.
// The menus are data rendered fresh on every open, the split buttons ride
// the same dropdown machinery, and everything that moved off the old
// toolbar kept its data-toolbar name -- these tests hold that promise.

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

const menuButton = (page, name) => page.locator(`[data-menu="${name}"]`);
const openPop = (page) => page.locator('.menu-pop:not([hidden])');

test.describe('the three rows', () => {
  test('identity, menus, actions — and the reserved slots say what they are', async ({ page }) => {
    await openLab(page);
    await expect(page.locator('[data-masthead]')).toBeVisible();
    await expect(page.locator('[data-menubar]')).toBeVisible();
    await expect(page.locator('[data-actionbar]')).toBeVisible();

    for (const name of ['file', 'edit', 'view', 'help']) {
      await expect(menuButton(page, name)).toBeVisible();
    }
    // The two placeholders: history is disabled (a promise, not a lie),
    // and the identity circle is a slot, not a button.
    await expect(page.locator('[data-history]')).toBeDisabled();
    await expect(page.locator('[data-identity]')).toBeVisible();
    await expect(page.locator('[data-identity]')).not.toHaveAttribute('role', 'button');
    // Start here moved up a row but kept its name.
    await expect(page.locator('[data-toolbar="examples"]')).toBeVisible();
  });

  test('the console collapses from its own header, and stays put', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-console-collapse]').click();
    await expect(page.locator('.console')).toBeHidden();
    // The pref write is fire-and-forget; give IndexedDB its beat before
    // the reload that is meant to read it back.
    await page.waitForTimeout(400);

    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(page.locator('.console')).toBeHidden();

    // View › Console brings it back, and that sticks too.
    await viaControl(page, 'toggle-console');
    await expect(page.locator('.console')).toBeVisible();
  });

  test('the masthead folds away and stays folded over a reload', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-masthead-toggle]').click();
    await expect(page.locator('[data-masthead]')).toBeHidden();

    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(page.locator('[data-masthead]')).toBeHidden();
    await page.locator('[data-masthead-toggle]').click();
    await expect(page.locator('[data-masthead]')).toBeVisible();
  });
});

test.describe('menu mechanics', () => {
  test('opens on click, closes on Escape and on clicking away', async ({ page }) => {
    await openLab(page);
    await menuButton(page, 'file').click();
    await expect(openPop(page)).toBeVisible();
    await expect(openPop(page).locator('[data-toolbar="save"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(openPop(page)).toHaveCount(0);

    await menuButton(page, 'file').click();
    await expect(openPop(page)).toBeVisible();
    await page.mouse.click(600, 400);
    await expect(openPop(page)).toHaveCount(0);
  });

  test('arrow keys walk items and adjacent menus', async ({ page }) => {
    await openLab(page);
    await menuButton(page, 'file').focus();
    await page.keyboard.press('ArrowDown');
    await expect(openPop(page)).toBeVisible();
    await expect(openPop(page).locator('.menu-item').first()).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(openPop(page).locator('.menu-item').nth(1)).toBeFocused();

    // Right from inside File lands on Edit, open.
    await page.keyboard.press('ArrowRight');
    await expect(menuButton(page, 'edit')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
  });

  test('disabled items say so and do nothing', async ({ page }) => {
    await openLab(page);
    // A fresh notebook has nothing to undo and nothing on the clipboard.
    await menuButton(page, 'edit').click();
    await expect(openPop(page).locator('[data-toolbar="undo"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(openPop(page).locator('[data-toolbar="paste-cell"]')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
  });
});

test.describe('File', () => {
  test('New replaces the notebook with a blank one', async ({ page }) => {
    await openLab(page);
    await expect(page.locator('.cell')).not.toHaveCount(1);
    await viaControl(page, 'new');
    await expect(page.locator('.cell')).toHaveCount(1);
    await expect(page.locator('[data-filename]')).toHaveText('untitled.ipynb');
    await expect(page.locator('[data-nb-title]')).toHaveText('Untitled notebook');
  });

  test('Show source shows the exact bytes a save would write', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'show-source');
    await expect(page.locator('[data-source]')).toBeVisible();

    const shown = await page.locator('[data-source-text]').inputValue();
    const saved = await page.evaluate(async () => {
      const { toIpynb } = await import('./src/notebook/ipynb.js');
      return JSON.stringify(toIpynb(window.lab.model), null, 1);
    });
    expect(shown).toBe(saved);
    expect(JSON.parse(shown).nbformat).toBe(4);
    await page.locator('[data-source-close]').click();
  });

  test('Ctrl+S downloads the notebook instead of the page', async ({ page }) => {
    await openLab(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.ipynb$/);
  });
});

test.describe('Edit', () => {
  test('copy and paste a cell, and cut removes it', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('print("original")');

    await viaControl(page, 'copy-cell');
    await viaControl(page, 'paste-cell');
    await expect(page.locator('.cell')).toHaveCount(2);
    await expect(page.locator('.cell').nth(1).locator('[data-editor]')).toHaveValue('print("original")');

    // The paste is the selected cell; cut removes it again.
    await viaControl(page, 'cut-cell');
    await expect(page.locator('.cell')).toHaveCount(1);
  });

  test('Duplicate notebook opens an editable copy under a copy name', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('hello'));
    await expect(page.locator('[data-nb-title]')).toHaveText('Hello, Diluvium');

    await viaControl(page, 'duplicate');
    await expect(page.locator('[data-nb-title]')).toHaveText('Copy of Hello, Diluvium');
    await expect(page.locator('[data-filename]')).toHaveText('copy-of-hello.ipynb');
  });
});

test.describe('View', () => {
  test('Hide code leaves markdown and outputs, and comes back', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('return 21 * 2');
    await page.locator('.cell [data-action="run"]').click();
    await expect(page.locator('.cell [data-outputs]')).toContainText('42');

    await viaControl(page, 'hide-code');
    await expect(page.locator('body')).toHaveAttribute('data-hide-code', 'true');
    await expect(page.locator('.cell [data-editor]')).toBeHidden();
    await expect(page.locator('.cell .cell-head')).toBeHidden();
    await expect(page.locator('.cell [data-outputs]')).toContainText('42');

    await viaControl(page, 'hide-code');
    await expect(page.locator('.cell [data-editor]')).toBeVisible();
  });

  test('Collapse all and Expand all fold every code cell', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.openExample('hello'));
    await viaControl(page, 'collapse-all');
    const counts = await page.evaluate(() => ({
      code: document.querySelectorAll('.cell[data-cell-type="code"]').length,
      folded: document.querySelectorAll('.cell[data-folded="true"]').length,
    }));
    expect(counts.folded).toBe(counts.code);

    await viaControl(page, 'expand-all');
    await expect(page.locator('.cell[data-folded="true"]')).toHaveCount(0);
  });

  test('the console can be put away and brought back', async ({ page }) => {
    await openLab(page);
    await expect(page.locator('.console')).toBeVisible();
    await viaControl(page, 'toggle-console');
    await expect(page.locator('.console')).toBeHidden();
    await viaControl(page, 'toggle-console');
    await expect(page.locator('.console')).toBeVisible();
  });

  test('the panel tools are listed, and toggle the panel', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'panel-outline');
    await expect(page.locator('[data-tool-panel]')).toBeVisible();
    await expect(page.locator('[data-tool-panel-title]')).toHaveText('Outline');
    await viaControl(page, 'panel-outline');
    await expect(page.locator('[data-tool-panel]')).toBeHidden();
  });
});

test.describe('read-only', () => {
  test('blocks editing, keeps running, and duplicate is the way out', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('return 40 + 2');

    await page.locator('[data-readonly]').click();
    await expect(page.locator('[data-readonly]')).toHaveText('Read-only');
    await expect(page.locator('body')).toHaveAttribute('data-read-only', 'true');

    // Typing is blocked at the editor itself, not by hiding it.
    await expect(page.locator('.cell [data-editor]')).toHaveJSProperty('readOnly', true);
    // Structural affordances are gone...
    await expect(page.locator('.cell [data-action="delete"]')).toBeHidden();
    await expect(page.locator('[data-toolbar="add-cell"]')).toBeHidden();
    // ...synthetic edits are refused at the choke point (Tab used to
    // slip through the textarea's readOnly and reach the model)...
    await page.locator('.cell [data-editor]').press('Tab');
    await expect(page.locator('.cell [data-editor]')).toHaveValue('return 40 + 2');
    // ...but running is not: read-only is about the file.
    await page.locator('.cell [data-action="run"]').click();
    await expect(page.locator('.cell [data-outputs]')).toContainText('42');
    // And run-with-advance on the last cell must not append a cell.
    await page.locator('.cell [data-editor]').press('Shift+Enter');
    await expect(page.locator('.cell')).toHaveCount(1);

    // The menu knows too.
    await menuButton(page, 'edit').click();
    await expect(openPop(page).locator('[data-toolbar="cut-cell"]')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    // Duplicate produces an editable copy.
    await viaControl(page, 'duplicate');
    await expect(page.locator('body')).not.toHaveAttribute('data-read-only', 'true');
    await expect(page.locator('.cell [data-editor]')).toHaveJSProperty('readOnly', false);
  });

  test('renaming is refused while read-only', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-readonly]').click();
    await page.locator('[data-nb-title]').click();
    await expect(page.locator('[data-nb-title-input]')).toBeHidden();
    await expect(page.locator('[data-toast]')).toContainText('read-only');
  });
});

test.describe('the save status', () => {
  test('an edit is announced, then the autosave lands', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').first().fill('-- edited');
    // pending -> saving -> saved; the end state is the observable one.
    await expect(page.locator('[data-save-status]')).toHaveText('saved', { timeout: 10_000 });
    await expect(page.locator('[data-save-status]')).toHaveAttribute('data-state', 'saved');
  });
});

test.describe('the launcher', () => {
  test('Home opens it, with examples and actions', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-home]').click();
    await expect(page.locator('[data-launcher]')).toBeVisible();
    // Counted from the bundle rather than written down: a hardcoded number
    // here is a thing to remember on every notebook added, and forgetting
    // it fails a launcher test for a reason that has nothing to do with
    // the launcher.
    const bundled = await page.evaluate(async () =>
      (await import('./src/notebook/examples.js')).EXAMPLES.length);
    expect(bundled).toBeGreaterThan(1);
    await expect(page.locator('[data-launcher-examples] .example-entry')).toHaveCount(bundled);

    // Opening an example from it adopts the notebook and closes it.
    await page.locator('[data-launcher-examples] .example-entry').first().click();
    await expect(page.locator('[data-launcher]')).toBeHidden();
    await expect(page.locator('[data-nb-title]')).toHaveText('Hello, Diluvium');
  });

  test('clicking the backdrop closes it, like every dialog', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-home]').click();
    const launcher = page.locator('[data-launcher]');
    await expect(launcher).toBeVisible();

    // A click inside the dialog's own padding does not close it.
    const box = await launcher.boundingBox();
    await page.mouse.click(box.x + 4, box.y + 4);
    await expect(launcher).toBeVisible();

    // A click on the backdrop does. (1,1) is the page's corner, which the
    // centered dialog never reaches.
    await page.mouse.click(1, 1);
    await expect(launcher).toBeHidden();

    // And the same behaviour holds for the other dialogs — About stands
    // in for the rest, since one listener serves them all.
    await viaControl(page, 'about');
    const about = page.locator('[data-about]');
    await expect(about).toBeVisible();
    await page.mouse.click(1, 1);
    await expect(about).toBeHidden();
  });

  test('Start here wears the accent, not the browser default', async ({ page }) => {
    await openLab(page);
    const style = await page.locator('.start-here').evaluate((node) => {
      const s = getComputedStyle(node);
      return { radius: s.borderRadius, cursor: s.cursor };
    });
    // The old selector (.toolbar .start-here) never matched -- the button
    // lives in the menubar -- so it rendered as a raw UA button.
    expect(style.radius).toBe('6px');
    expect(style.cursor).toBe('pointer');
  });

  test('New notebook puts the caret in the blank cell', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-home]').click();
    await page.locator('[data-launcher-new]').click();
    // The launcher says "start typing in a blank one" -- so typing must
    // land somewhere, not on the Home button the dialog refocuses.
    await page.keyboard.type('print("typed straight in")');
    await expect(page.locator('.cell [data-editor]').first())
      .toHaveValue('print("typed straight in")');
  });

  test('opening over unsaved work stashes it in recents first', async ({ page }) => {
    await openLab(page);
    const editor = page.locator('.cell[data-cell-type="code"] [data-editor]').first();
    await editor.fill('rescue_me = 42');
    await page.locator('[data-home]').click();
    await page.locator('[data-launcher-examples] .example-entry').first().click();
    await expect(page.locator('[data-nb-title]')).toHaveText('Hello, Diluvium');
    // The replaced notebook's only copy was the autosave slot the example
    // just took over; the stash is what keeps it reachable.
    const stashed = await page.evaluate(async () => {
      const { listRecent } = await import('./src/notebook/storage.js');
      return (await listRecent()).some((entry) =>
        entry.origin === 'replaced' && (entry.ipynb ?? '').includes('rescue_me'));
    });
    expect(stashed).toBe(true);
  });

  test('a true first visit gets the launcher unprompted', async ({ page }) => {
    // No openLab: a fresh context with an empty database IS the first
    // visit, and nothing here dismisses anything.
    await page.goto('/');
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await expect(page.locator('[data-launcher]')).toBeVisible();

    // Closing it and reloading does not nag: once is an offer, twice is a
    // popup.
    await page.locator('[data-launcher-close]').click();
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await expect(page.locator('[data-launcher]')).toBeHidden();
  });
});

test.describe('help for the keyboard and the language', () => {
  test('Help opens the shortcuts reference, and it closes again', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'shortcuts');
    const dialog = page.locator('[data-shortcuts]');
    await expect(dialog).toBeVisible();
    // The two keys a newcomer needs first are both in it.
    await expect(dialog).toContainText('Ctrl+Enter');
    await expect(dialog).toContainText('Ctrl+Space');
    await page.locator('[data-shortcuts-close]').click();
    await expect(dialog).toBeHidden();
  });

  test('the launcher links back to the Diluvium site', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-home]').click();
    const link = page.locator('[data-launcher] a[href="https://diluvium.aloecraft.org"]');
    await expect(link).toBeVisible();
    // In a new tab, and without a handle on this page.
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener');
  });

  test('an empty cell says which keys matter, a filled one says nothing', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    const editor = page.locator('.cell[data-cell-type="code"] [data-editor]').first();
    await expect(editor).toHaveAttribute('placeholder', /Ctrl\+Enter/);
    // A placeholder only exists while the editor is empty -- typing one
    // character removes the nudge without anything having to manage it.
    await editor.fill('print(1)');
    const shown = await editor.evaluate((node) => {
      const style = getComputedStyle(node);
      return node.value === '' && style.visibility !== 'hidden';
    });
    expect(shown).toBe(false);
  });
});

test.describe('the split buttons', () => {
  test('+ Cell adds the kind it last added', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await viaControl(page, 'add-markdown');
    await expect(page.locator('.cell').nth(1)).toHaveAttribute('data-cell-type', 'markdown');

    // The main button repeats the last kind.
    await page.locator('[data-toolbar="add-cell"]').click();
    await expect(page.locator('.cell').nth(2)).toHaveAttribute('data-cell-type', 'markdown');

    await viaControl(page, 'add-code');
    await page.locator('[data-toolbar="add-cell"]').click();
    await expect(page.locator('.cell').nth(4)).toHaveAttribute('data-cell-type', 'code');
  });

  test('run above and run below split at the focused cell', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').fill('print("first")');
    await viaControl(page, 'add-code');
    await page.locator('.cell').nth(1).locator('[data-editor]').fill('print("second")');
    await viaControl(page, 'add-code');
    await page.locator('.cell').nth(2).locator('[data-editor]').fill('print("third")');

    await page.locator('.cell').nth(1).locator('[data-editor]').click();
    await viaControl(page, 'run-above');
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false');
    await expect(page.locator('.cell').nth(0).locator('[data-outputs]')).toContainText('first');
    await expect(page.locator('.cell').nth(1).locator('[data-outputs] .output')).toHaveCount(0);

    await page.locator('.cell').nth(1).locator('[data-editor]').click();
    await viaControl(page, 'run-below');
    await expect(page.locator('body')).toHaveAttribute('data-running', 'false');
    await expect(page.locator('.cell').nth(1).locator('[data-outputs]')).toContainText('second');
    await expect(page.locator('.cell').nth(2).locator('[data-outputs]')).toContainText('third');
  });

  test('restart lives behind the kernel arrow and still restarts', async ({ page }) => {
    await openLab(page);
    await viaControl(page, 'new');
    await page.locator('.cell [data-editor]').first().fill('leak = 1 return leak');
    await page.locator('.cell [data-action="run"]').first().click();
    await expect(page.locator('.cell [data-outputs]').first()).toContainText('1');

    await viaControl(page, 'restart');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 30_000 });
    const after = await page.evaluate(async () => {
      const out = [];
      await window.lab.kernel.execute('print(tostring(leak))', (m) => out.push(m.content.text ?? ''));
      return out.join('');
    });
    expect(after).toContain('nil');
  });
});
