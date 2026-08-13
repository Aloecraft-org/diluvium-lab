import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dismissLauncher } from './chrome.js';

// The diagram renderer: the one thing this page fetches that is not a
// Diluvium release.
//
// Every test here **intercepts the CDN**, the way versions.spec.js
// intercepts the runtime mirror. Two reasons, and the second is the
// important one: CI should not depend on jsDelivr being up, and a test
// that really downloaded 3.4 MB to assert a checksum would be asserting
// the network rather than the code.
//
// What that costs in honesty is stated rather than hidden: these prove the
// fetch/verify/cache/run path, and they do not prove that the pinned
// sha256 matches what jsDelivr serves. It was computed from the npm
// tarball, which is the same artifact, on a network that could not reach
// the CDN to confirm it. A mismatch shows up as a refusal with both
// digests in the message — visible, not silent.

/** The real bundle, if someone has put it here. Optional on purpose. */
const REAL = 'scratch/mermaid.min.js';

async function openLab(page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
}

/**
 * A stand-in bundle: the same *shape* as mermaid's IIFE — assigns to the
 * global it assigns to, exposes `initialize` and `render` — and none of
 * its size. What is under test is the loader, and the loader cannot tell
 * the difference, which is the point.
 */
const STUB = `
(globalThis.__esbuild_esm_mermaid_nm ||= {}).mermaid = {
  initialize() { this.ready = true; },
  async render(id, source) {
    if (source.includes('EXPLODE')) throw new Error('bad diagram');
    return { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<title>' + source.split('\\n').length + ' lines</title>'
      + '<script>window.__pwned = true;<\\/script>'
      + '<a href="https://example.com/evil" onclick="window.__pwned = true"><rect width="4" height="4"/></a>'
      + '<use href="#nope"/>'
      + '<circle cx="5" cy="5" r="4" fill="#888"/></svg>' };
  },
};
`;

const stubSha = createHash('sha256').update(STUB).digest('hex');

// Handed *into* the page rather than read from module scope there: these
// serve a stand-in bundle, so they must tell the loader which digest to
// require. The verification it then performs is the real one — there is no
// way to switch the check off, only to say what it should expect.

/** Serve `body` for the CDN URL, and report how many times it was asked. */
async function interceptCdn(page, body) {
  const state = { hits: 0 };
  await page.route('https://cdn.jsdelivr.net/**', async (route) => {
    state.hits += 1;
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  return state;
}

test.describe('loading it', () => {
  test('the menu item downloads, verifies, caches and starts it', async ({ page }) => {
    const cdn = await interceptCdn(page, STUB);
    await openLab(page);

    const first = await page.evaluate(async (expected) => {
      const m = await import('./src/notebook/mermaid.js');
      const stages = [];
      await m.loadMermaid({ expected, onProgress: (s) => stages.push(s) });
      return { stages, loaded: m.mermaidLoaded(), cached: await m.mermaidCached() };
    }, stubSha);
    expect(cdn.hits).toBe(1);
    expect(first.loaded).toBe(true);
    expect(first.cached).toBe(true);
    // It says what it is doing, because 3.4 MB on someone's connection is
    // long enough that a silent button reads as a broken one.
    expect(first.stages.join(' ')).toMatch(/downloading/i);
    expect(first.stages.join(' ')).toMatch(/checking/i);

    // A reload finds it in IndexedDB and asks the network for nothing.
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    const second = await page.evaluate(async (expected) => {
      const m = await import('./src/notebook/mermaid.js');
      const stages = [];
      await m.loadMermaid({ expected, onProgress: (s) => stages.push(s) });
      return { stages, loaded: m.mermaidLoaded() };
    }, stubSha);
    expect(second.loaded).toBe(true);
    expect(cdn.hits).toBe(1);
    expect(second.stages.join(' ')).not.toMatch(/downloading/i);
  });

  test('bytes that do not match the pinned checksum are refused, not run', async ({ page }) => {
    await interceptCdn(page, `${STUB}\n// tampered\n`);
    await openLab(page);
    const out = await page.evaluate(async (expected) => {
      const m = await import('./src/notebook/mermaid.js');
      try {
        await m.loadMermaid({ expected });
        return { refused: null, loaded: m.mermaidLoaded() };
      } catch (err) {
        return { refused: err.message, loaded: m.mermaidLoaded(), cached: await m.mermaidCached() };
      }
    }, stubSha);
    // Both digests in the message: "it did not match" without saying what
    // it was is a message you cannot act on.
    expect(out.refused).toMatch(/sha256/);
    expect(out.refused).toMatch(/refused rather than run/);
    expect(out.loaded).toBe(false);
    // And nothing that failed the check was kept.
    expect(out.cached).toBe(false);
  });

  test('a CDN that is not there says so and leaves the Lab working', async ({ page }) => {
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort('connectionfailed'));
    await openLab(page);
    const message = await page.evaluate(async (expected) => {
      const m = await import('./src/notebook/mermaid.js');
      try { await m.loadMermaid({ expected }); return null; } catch (err) { return err.message; }
    }, stubSha);
    expect(message).toContain('cdn.jsdelivr.net');
    // The page is untouched by a failed optional download.
    await page.locator('.cell').first().locator('[data-action="run"]').click();
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 60_000 });
  });
});

test.describe('rendering with it', () => {
  test('the panel draws the topology through Mermaid once it is loaded', async ({ page }) => {
    await interceptCdn(page, STUB);
    await openLab(page);
    await page.locator('[data-tool="swarm"]').click();
    await page.locator('[data-swarm="swarm-start"]').click();
    await page.locator('[data-swarm="swarm-run"]').click();
    await expect(page.locator('[data-swarm-graph]')).toBeVisible({ timeout: 15_000 });

    // Before: text only. The hand-drawn SVG is always there.
    await expect(page.locator('[data-swarm-mermaid-drawn]')).toHaveCount(0);

    await page.evaluate((d) => window.lab.loadDiagramRenderer({ expected: d }), stubSha);
    await expect(page.locator('[data-swarm-mermaid-drawn] svg')).toHaveCount(1, { timeout: 15_000 });
    // Drawn *as well as*, not instead of: the one that needs no download
    // stays, because it is the one that always works. Counted rather than
    // asserted visible -- the text lives inside a closed <details>, so it
    // is in the document and not rendered.
    await expect(page.locator('[data-swarm-graph]')).toBeVisible();
    await expect(page.locator('[data-swarm-mermaid]')).toHaveCount(1);
    await expect(page.locator('[data-swarm-topology] summary'))
      .toHaveText(/drawn by Mermaid/i);
  });

  test('what the renderer returns is scrubbed before it reaches the page', async ({ page }) => {
    await interceptCdn(page, STUB);
    await openLab(page);
    const out = await page.evaluate(async (expected) => {
      const m = await import('./src/notebook/mermaid.js');
      await m.loadMermaid({ expected });
      const svg = await m.renderMermaid('flowchart TD\n  a-->b');
      document.body.appendChild(svg);
      return {
        pwned: window.__pwned ?? false,
        scripts: svg.querySelectorAll('script').length,
        uses: svg.querySelectorAll('use').length,
        onclick: svg.querySelector('a')?.getAttribute('onclick') ?? null,
        href: svg.querySelector('a')?.getAttribute('href') ?? null,
        // The drawing itself survives the scrub, which is the other half:
        // a sanitiser that removed the diagram would also pass a test that
        // only checked for scripts.
        circles: svg.querySelectorAll('circle').length,
        title: svg.querySelector('title')?.textContent ?? null,
      };
    }, stubSha);
    // A string of markup never becomes HTML here: it is parsed as SVG and
    // stripped. `window.__pwned` staying false is the whole assertion.
    expect(out.pwned).toBe(false);
    expect(out.scripts).toBe(0);
    expect(out.uses).toBe(0);
    expect(out.onclick).toBeNull();
    expect(out.href).toBeNull();
    expect(out.circles).toBe(1);
    expect(out.title).toBe('2 lines');
  });

  test('a diagram the renderer chokes on leaves the text rather than the panel', async ({ page }) => {
    await interceptCdn(page, STUB);
    await openLab(page);
    const message = await page.evaluate(async (expected) => {
      const m = await import('./src/notebook/mermaid.js');
      await m.loadMermaid({ expected });
      try { await m.renderMermaid('EXPLODE'); return null; } catch (err) { return err.message; }
    }, stubSha);
    expect(message).toContain('bad diagram');
  });
});

// Runs only where someone has put the real bundle in scratch/. It is the
// one check a stub cannot make: that the pinned digest is the digest of
// the file this build actually names, and that mermaid itself renders the
// topology text this repo generates.
test.describe('against the real bundle', () => {
  test.skip(!existsSync(REAL), 'scratch/mermaid.min.js is not present');

  test('the pinned sha256 is this file, and it renders our topology', async ({ page }) => {
    const bytes = readFileSync(REAL);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const pinned = /MERMAID_SHA256 =\s*'([0-9a-f]{64})'/
      .exec(readFileSync('src/notebook/mermaid.js', 'utf8'))[1];
    expect(digest).toBe(pinned);

    await interceptCdn(page, bytes.toString('utf8'));
    await openLab(page);
    const out = await page.evaluate(async () => {
      const m = await import('./src/notebook/mermaid.js');
      await m.loadMermaid();
      const svg = await m.renderMermaid(
        'flowchart TD\n  host[["host"]]\n  i1("1 root")\n  host -->|"http_in x1"| i1');
      return { tag: svg.tagName, texts: svg.querySelectorAll('text').length };
    });
    expect(out.tag.toLowerCase()).toBe('svg');
    expect(out.texts).toBeGreaterThan(0);
  });
});
