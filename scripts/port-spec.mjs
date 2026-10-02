// Copies one of the page's specs into test/launcher/ported/, rewritten for
// the launcher: the page's chrome helpers become test/launcher/chrome.js's,
// `openLab` opens the launcher with a notebook, and the controls that were
// toolbar buttons become Lab menu entries. Mechanical on purpose; what the
// script cannot rewrite, a port edits by hand and says so at the top.
//
//   node scripts/port-spec.mjs notebook undo worker ipynb display
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const names = process.argv.slice(2);
if (!names.length) { console.error('usage: node scripts/port-spec.mjs <spec name>...'); process.exit(1); }
await mkdir(new URL('test/launcher/ported/', root), { recursive: true });

for (const name of names) {
  let text = await readFile(new URL(`test/${name}.spec.js`, root), 'utf8');
  const notes = [];
  const rewrite = (pattern, replacement, note) => {
    const before = text;
    text = text.replace(pattern, replacement);
    if (text !== before && note) notes.push(note);
  };
  rewrite(/import \{ ([^}]*) \} from '\.\/chrome\.js';/, "import { viaControl, dismissLauncher, openLab as openLauncherLab, viaMenu, viaSubmenu, replaced } from '../chrome.js';", 'chrome helpers from ../chrome.js');
  // The page's boot and readiness, wherever a spec spelled it.
  rewrite(/await page\.goto\('\/'\);\s*await page\.waitForSelector\('body\[data-ready="true"\]'[^)]*\);\s*(await dismissLauncher\(page\);)?/g, 'await openLauncherLab(page, { fresh: false });', 'goto + data-ready → openLauncherLab');
  rewrite(/await page\.reload\(\);\s*await page\.waitForSelector\('body\[data-ready="true"\]'[^)]*\);\s*(await dismissLauncher\(page\);)?/g, 'await page.reload();\n  await openLauncherLab(page, { fresh: false });', 'reload + data-ready → reload + openLauncherLab');
  rewrite(/await page\.waitForSelector\('body\[data-ready="true"\]'[^)]*\);/g, "await expect(page.locator('.lab-notebook [data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });", 'data-ready → kernel idle');
  // Clearing the store through the page's modules becomes a database drop.
  rewrite(/await page\.evaluate\(async \(\) => \{\s*const \{[^}]*clearAutosave[^}]*\} = await import\('\.\/src\/notebook\/storage\.js'\);[\s\S]*?\}\);/g, "await page.evaluate(() => new Promise((done) => { const r = indexedDB.deleteDatabase('diluvium-lab'); r.onsuccess = r.onerror = r.onblocked = () => done(); }));", 'clearing the store → deleteDatabase');
  // The page's modules are in the bundle; the handle exposes the ones the specs import.
  rewrite(/await import\('\.\/src\/([a-z/-]+)\.js'\)/g, "window.lab.modules['$1']", 'dynamic imports → window.lab.modules');
  rewrite(/\{ loadAutosave \}/g, '{ loadNotebook }', 'the autosave slot is the active notebook\'s');
  rewrite(/loadAutosave\(\)/g, 'loadNotebook(window.lab.notebook.slot)');
  // The page's hidden file input is a file chooser here, raised by Open .ipynb…
  rewrite(/await page\.locator\('\[data-file-input\]'\)\.setInputFiles\(([\s\S]*?\n\s*\})\);/g, "const chooser = page.waitForEvent('filechooser');\n  await viaMenu(page, 'Lab', 'Open .ipynb…');\n  await (await chooser).setFiles($1);\n  await replaced(page);", 'the file input → the file chooser');
  rewrite(/'\.\.\/notebooks\//g, "'../../../notebooks/", 'fixtures two levels up');
  rewrite(/page\.locator\('\[data-console\]'\)/g, "page.locator('.lab-console')", 'the console is the panel');
  rewrite(/\s*await expect\(page\.locator\('\[data-toast\]'\)\)\.toHaveAttribute\('data-kind', 'error'\);/g, '', 'the launcher\'s notice has no severity, so that assertion goes');
  rewrite(/page\.locator\('\[data-toast\]'\)/g, "page.locator('.dirt-toast').last()", 'the toast is the launcher\'s notice');
  rewrite(/page\.locator\('\[data-toolbar="([a-z-]+)"\]'\)\.click\(\)/g, "viaControl(page, '$1')", 'data-toolbar clicks → viaControl');
  rewrite(/page\.locator\('\[data-toolbar="stop"\]'\)/g, "page.locator('.dirt-tab-actions button', { hasText: 'Stop' })", 'the Stop button is the tab bar action');
  rewrite(/page\.locator\('body'\)\)\.toHaveAttribute\('data-kernel-state'/g, "page.locator('.lab-notebook')).toHaveAttribute('data-kernel-state'", 'body data-kernel-state → the panel');
  rewrite(/page\.locator\('\[data-kernel-status\]'\)/g, "page.locator('.lab-notebook [data-kernel-status]')", 'kernel status in the footer');
  rewrite(/page\.locator\('body'\)\)\.toHaveAttribute\('data-running'/g, "page.locator('.lab-notebook')).toHaveAttribute('data-running'", 'body data-running → the panel');
  rewrite(/page\.locator\('\.sheet'\)/g, "page.locator('.lab-notebook .lab-sheet')", 'the sheet is the panel\'s');
  rewrite(/page\.locator\('\[data-console-(input|log)\]'\)/g, "page.locator('.lab-console [data-console-$1]')", 'console selectors scoped to the panel');
  // The masthead's inline title editor is the Rename dialog here, and the title shows on the tab.
  rewrite(/await page\.locator\('\[data-nb-title\]'\)\.click\(\);\s*await page\.locator\('\[data-nb-title-input\]'\)\.fill\(([^)]*)\);\s*await page\.locator\('\[data-nb-title-input\]'\)\.press\('Enter'\);/g,
    "await viaControl(page, 'rename');\n    await page.locator('.dirt-dialog [data-title-input]').fill($1);\n    await page.locator('.dirt-dialog .btn-primary').click();", 'the title editor → the Rename dialog');
  rewrite(/page\.locator\('\[data-nb-title\]'\)\)\.toHaveText\('Untitled notebook'\)/g, "page.locator('.lm-TabBar-tab.lm-mod-current .lm-TabBar-tabLabel').first()).toHaveText('untitled')", 'an untitled notebook\'s tab reads its filename');
  rewrite(/page\.locator\('\[data-nb-title\]'\)/g, "page.locator('.lm-TabBar-tab.lm-mod-current .lm-TabBar-tabLabel').first()", 'the title is the tab\'s');
  const header = `// Ported from test/${name}.spec.js by scripts/port-spec.mjs for the lab inside\n// DiRT Launcher. Rewrites applied: ${notes.join('; ') || 'none'}.\n// Edit the original; re-run the script; keep hand edits below this line small.\n\n`;
  await writeFile(new URL(`test/launcher/ported/${name}.spec.js`, root), header + text);
  console.log(`ported ${name}: ${notes.length} rewrites`);
}
