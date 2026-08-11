import { test, expect } from '@playwright/test';

// Opening a notebook from a URL, and remembering what was opened.
//
// The remote fetches are stubbed with `page.route`, for the same reason
// versions.spec.js stubs the mirror: a test that depends on GitHub being
// up is a test that fails for reasons that are not about this code. What
// is *not* stubbed is the decision of which URL to request — that is
// asserted on the request itself, so the GitHub rewrite is checked against
// what actually went out.

const RAW = 'https://raw.githubusercontent.com/owner/repo/main/notebooks/hello.ipynb';

const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Fetched\n'] },
    { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['return 41 + 1'] },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
};

async function openLab(page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await page.evaluate(async () => {
    const { clearAutosave, clearRecent } = await import('./src/notebook/storage.js');
    await clearAutosave();
    await clearRecent();
  });
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

/**
 * Serve `body` for any https request, and record what was asked for.
 *
 * A regex rather than the glob `https://**`, which does not match:
 * Playwright's glob does not take `**` directly after the scheme, and the
 * symptom is silence -- no interception, and a real fetch that fails with
 * "Failed to fetch", which reads exactly like the CORS error this feature
 * is *supposed* to produce. Cost half an hour; hence this comment.
 */
async function stubRemote(page, body, { status = 200, contentType = 'application/json' } = {}) {
  const asked = [];
  await page.route(/^https:\/\//, async (route) => {
    asked.push(route.request().url());
    await route.fulfill({ status, contentType, body });
  });
  return asked;
}

async function openFromUrl(page, url) {
  await page.locator('[data-toolbar="open-url"]').click();
  await page.locator('[data-open-url-input]').fill(url);
  await page.locator('[data-open-url-go]').click();
}

test.describe('opening from a URL', () => {
  test('fetches, parses and adopts the notebook', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, JSON.stringify(NOTEBOOK));
    await openFromUrl(page, RAW);

    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');
    await expect(page.locator('[data-toast]')).toContainText('raw.githubusercontent.com');
    // The name comes from the URL's last segment, which is the only thing
    // a URL says about what a notebook is called.
    expect(await page.evaluate(() => window.lab.model.cells.length)).toBe(2);
    await expect(page.locator('.rendered').first()).toContainText('Fetched');
  });

  test('a GitHub page URL is rewritten to its raw form', async ({ page }) => {
    await openLab(page);
    const asked = await stubRemote(page, JSON.stringify(NOTEBOOK));
    // The mistake people actually make: pasting the page they were looking
    // at. Fetching it succeeds and returns HTML, and JSON's own complaint
    // about `<` explains nothing.
    await openFromUrl(page, 'https://github.com/owner/repo/blob/main/notebooks/hello.ipynb');

    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');
    expect(asked).toEqual([RAW]);
  });

  test('a page instead of a notebook says which mistake was made', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, '<!doctype html><title>not a notebook</title>', { contentType: 'text/html' });
    await openFromUrl(page, 'https://example.org/notebooks/hello.ipynb');

    await expect(page.locator('[data-toast]')).toContainText('served a web page rather than a notebook');
    await expect(page.locator('[data-filename]')).not.toHaveText('hello.ipynb');
  });

  test('a blocked cross-origin fetch explains itself', async ({ page }) => {
    await openLab(page);
    // What a host without `Access-Control-Allow-Origin` looks like from a
    // page: an opaque failure with no status and no reason, on purpose.
    // Repeating "Failed to fetch" is what sends someone to devtools.
    await page.route(/^https:\/\//, (route) => route.abort('failed'));
    await openFromUrl(page, 'https://example.org/hello.ipynb');

    await expect(page.locator('[data-toast]')).toContainText('Access-Control-Allow-Origin');
    await expect(page.locator('[data-toast]')).toContainText('example.org');
  });

  test('a 404 reports the status rather than a parse error', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, 'nope', { status: 404, contentType: 'text/plain' });
    await openFromUrl(page, RAW);
    await expect(page.locator('[data-toast]')).toContainText('404');
  });

  test('a non-http URL is refused before anything is fetched', async ({ page }) => {
    await openLab(page);
    const asked = await stubRemote(page, JSON.stringify(NOTEBOOK));
    await openFromUrl(page, 'file:///etc/passwd');
    await expect(page.locator('[data-toast]')).toContainText('http and https');
    expect(asked).toEqual([]);
  });
});

test.describe('a ?open= link asks first', () => {
  test('shows the host and fetches nothing until told to', async ({ page }) => {
    // "No external requests at load" is a hard constraint. A link somebody
    // sent you is not a decision you made, so this is a question rather
    // than a fetch -- and the question names what it would talk to.
    const asked = [];
    await page.route(/^https:\/\//, async (route) => {
      asked.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NOTEBOOK) });
    });

    await page.goto(`/?open=${encodeURIComponent(RAW)}`);
    await page.waitForSelector('[data-link-banner]:not([hidden])', { timeout: 30_000 });
    await expect(page.locator('[data-link-banner]')).toContainText('raw.githubusercontent.com');
    expect(asked).toEqual([]);

    await page.locator('[data-link-open]').click();
    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');
    expect(asked).toEqual([RAW]);
  });

  test('declining leaves the notebook alone, and the link does not ask twice', async ({ page }) => {
    const asked = await stubRemote(page, JSON.stringify(NOTEBOOK));
    await page.goto(`/?open=${encodeURIComponent(RAW)}`);
    await page.waitForSelector('[data-link-banner]:not([hidden])', { timeout: 30_000 });

    await page.locator('[data-link-dismiss]').click();
    await expect(page.locator('[data-link-banner]')).toBeHidden();
    expect(asked).toEqual([]);
    // Dropped from the address bar, so a reload is not asked the same
    // question again.
    expect(page.url()).not.toContain('open=');
  });
});

test.describe('recently opened', () => {
  test('remembers what was opened, and reopens it from the stored copy', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, JSON.stringify(NOTEBOOK));
    await openFromUrl(page, RAW);
    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');

    await page.locator('[data-toolbar="recent"]').click();
    await expect(page.locator('.recent-entry')).toHaveCount(1);
    await expect(page.locator('.recent-entry')).toContainText('hello.ipynb');
    await expect(page.locator('.recent-entry')).toContainText(RAW);
    await page.locator('[data-recent-close]').click();

    // Reopening comes from the stored copy rather than the network, which
    // is what makes a *file* entry work at all and what makes a URL entry
    // work offline.
    await page.route(/^https:\/\//, (route) => route.abort('failed'));
    await page.evaluate(() => window.lab._setModel(new (window.lab.model.constructor)()));
    await page.locator('[data-toolbar="recent"]').click();
    await page.locator('.recent-entry').click();
    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');
    expect(await page.evaluate(() => window.lab.model.cells.length)).toBe(2);
  });

  test('opening the same notebook twice moves it up rather than doubling it', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, JSON.stringify(NOTEBOOK));
    await openFromUrl(page, RAW);
    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');
    await openFromUrl(page, RAW);
    await page.waitForTimeout(300);

    await page.locator('[data-toolbar="recent"]').click();
    await expect(page.locator('.recent-entry')).toHaveCount(1);
  });

  test('survives a reload, which is the whole point of remembering', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, JSON.stringify(NOTEBOOK));
    await openFromUrl(page, RAW);
    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');

    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await page.locator('[data-toolbar="recent"]').click();
    await expect(page.locator('.recent-entry')).toContainText('hello.ipynb');
  });

  test('says so when there is nothing to show', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-toolbar="recent"]').click();
    await expect(page.locator('[data-recent-empty]')).toBeVisible();
  });

  test('forgetting empties it', async ({ page }) => {
    await openLab(page);
    await stubRemote(page, JSON.stringify(NOTEBOOK));
    await openFromUrl(page, RAW);
    await expect(page.locator('[data-filename]')).toHaveText('hello.ipynb');

    await page.locator('[data-toolbar="recent"]').click();
    await page.locator('[data-recent-clear]').click();
    await page.locator('[data-toolbar="recent"]').click();
    await expect(page.locator('[data-recent-empty]')).toBeVisible();
  });
});
