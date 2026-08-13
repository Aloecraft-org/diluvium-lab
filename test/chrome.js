// Helpers for the three-row chrome, shared by the specs.
//
// The controls kept their `data-toolbar` names when they moved into menus
// and split-button dropdowns, so a spec still names the same thing -- it
// just may need the container opened first. `viaControl` knows where
// everything lives; specs keep saying *what*, not *where*.

/** Which menu each moved control lives in, by data-toolbar name. */
const MENU_OF = {
  new: 'file', open: 'file', 'open-url': 'file', recent: 'file',
  save: 'file', 'show-source': 'file',
  undo: 'edit', redo: 'edit', 'cut-cell': 'edit', 'copy-cell': 'edit',
  'paste-cell': 'edit', 'clear-outputs': 'edit', duplicate: 'edit',
  'hide-code': 'view', 'collapse-all': 'view', 'expand-all': 'view',
  'toggle-console': 'view', 'panel-outline': 'view',
  'theme-system': 'view', 'theme-light': 'view', 'theme-dark': 'view',
  docs: 'help', about: 'help',
};

/** Which split-button dropdown, for the rest. */
const SPLIT_OF = {
  'add-code': 'add', 'add-markdown': 'add',
  'run-focused': 'run', 'run-above': 'run', 'run-below': 'run',
  'sandbox-focused': 'run',
  restart: 'kernel',
};

/**
 * Click a control by its data-toolbar name, opening the menu or split
 * dropdown that holds it when it is not a bare toolbar button.
 */
export async function viaControl(page, name) {
  const direct = page.locator(`[data-toolbar="${name}"]`);
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
    return;
  }
  if (MENU_OF[name]) await page.locator(`[data-menu="${MENU_OF[name]}"]`).click();
  else if (SPLIT_OF[name]) await page.locator(`[data-split="${SPLIT_OF[name]}"]`).click();
  else throw new Error(`viaControl: nowhere known holds "${name}"`);
  await page.locator(`.menu-pop [data-toolbar="${name}"]`).click();
}

/**
 * A genuinely first visit shows the launcher; specs that are not about
 * the launcher close it and move on. Safe to call when it is not open.
 */
export async function dismissLauncher(page) {
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-launcher]');
    if (dialog?.open) dialog.close();
  });
}
