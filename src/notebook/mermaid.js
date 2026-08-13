// Mermaid, fetched once and kept.
//
// ## This amends a hard constraint, deliberately
//
// `CLAUDE.md` says: no CDN, no external requests at load, everything
// vendored, and *"the only network calls are the ones that fetch Diluvium
// releases, and those are explicit and user-initiated."* This adds a
// second kind of call, so it is an amendment rather than an application —
// recorded in ROADMAP and agreed before it was written.
//
// What the constraint was protecting is kept intact. Nothing here happens
// at load: the page comes up, runs cells and draws its own diagrams with
// no network at all, and this module does nothing until someone picks a
// menu item. The download is verified against a checksum pinned in this
// file, cached in IndexedDB, and never fetched again.
//
// **Why not vendor it.** `mermaid.min.js` is 3.4 MB, which is three times
// the kernel. Vendoring would put it in every clone and every `git pull`,
// and `dist/diluvium-lab.html` — a file whose entire purpose is being
// small enough to email — would go from 2.3 MB to nearly 6 MB to carry a
// renderer most sessions never open.
//
// **Why the IIFE build and not the ESM one.** Checked rather than assumed:
// `dist/mermaid.min.js` is an esbuild IIFE with **no dynamic imports and
// no chunk references**, so it runs from a Blob URL. The ESM build splits
// into 44 chunks it loads by relative path, which resolve against the blob
// and fail. That difference is the whole reason this approach works.

import { sha256, bytesToHex } from '../kernel/sha256.js';
import { getAsset, putAsset } from './storage.js';

export const MERMAID_VERSION = '11.16.1';
export const MERMAID_URL =
  `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

/**
 * The sha256 of `mermaid@11.16.1/dist/mermaid.min.js`.
 *
 * Computed from the npm tarball (`npm pack mermaid@11.16.1`). jsDelivr
 * serves npm's published bytes, so the two should agree — *should*, and
 * not verified against the CDN, because the network this was written on
 * cannot reach it. If they disagree the download is refused and says so,
 * which is the safe direction to be wrong in: a mismatch is visible rather
 * than silent, and fixing it is editing one line here.
 */
export const MERMAID_SHA256 =
  '18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954';

/** Roughly, for a message that says what a click is about to cost. */
export const MERMAID_MB = 3.4;

const CACHE_KEY = `mermaid@${MERMAID_VERSION}`;

/** The IIFE assigns here. Its own name, not one this file chose. */
const GLOBAL = '__esbuild_esm_mermaid_nm';

let api = null;

/** Is the renderer loaded *in this page*, right now? */
export function mermaidLoaded() {
  return api !== null;
}

/** Is it in IndexedDB, so loading it would cost no network? */
export async function mermaidCached() {
  const record = await getAsset(CACHE_KEY).catch(() => null);
  return !!record?.bytes?.length;
}

/** Tests only, and the reason `api` is not exported directly. */
export function resetMermaid() {
  api = null;
  delete globalThis[GLOBAL];
}

/**
 * Load it: from IndexedDB if it is there, from the network if it is not.
 *
 * @param {object} [options]
 * @param {string} [options.url] where to fetch from; a test points this
 *   at a fixture rather than at the CDN
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.expected] the sha256 to require. A parameter
 *   rather than a constant read from module scope so a test can serve a
 *   stand-in bundle and still exercise the real verification, instead of
 *   the verification having a way to be switched off.
 * @param {(stage: string) => void} [options.onProgress]
 */
export async function loadMermaid({
  url = MERMAID_URL,
  fetchImpl = (...args) => fetch(...args),
  expected = MERMAID_SHA256,
  onProgress = () => {},
} = {}) {
  if (api) return api;

  let bytes = (await getAsset(CACHE_KEY).catch(() => null))?.bytes ?? null;
  const fromCache = !!bytes?.length;

  if (!fromCache) {
    onProgress(`downloading mermaid ${MERMAID_VERSION} (~${MERMAID_MB} MB)`);
    let response;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      throw new Error(
        `could not reach ${new URL(url).host} to download the diagram renderer: ${err.message}`);
    }
    if (!response.ok) {
      throw new Error(`${new URL(url).host} answered ${response.status} for the diagram renderer`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }

  // Verified whether it came from the network or from the cache. The
  // cached copy is checked too because the point of a checksum is to
  // notice bytes that changed without anyone deciding they should, and
  // IndexedDB is as capable of that as a CDN is.
  //
  // Hashed with the vendored synchronous SHA-256 rather than
  // `crypto.subtle`, which the runtime downloads use: subtle needs a
  // secure context and is therefore absent over `file://`, and there is
  // no reason for this to inherit that limitation.
  onProgress(fromCache ? 'checking the cached copy' : 'checking the download');
  const digest = bytesToHex(sha256(bytes));
  if (digest !== expected) {
    if (fromCache) await putAsset(CACHE_KEY, null).catch(() => {});
    throw new Error(
      `the diagram renderer's sha256 is ${digest.slice(0, 16)}… and this build expects `
      + `${expected.slice(0, 16)}…, so it was refused rather than run`);
  }

  if (!fromCache) {
    onProgress('storing it, so this happens once');
    await putAsset(CACHE_KEY, { bytes, version: MERMAID_VERSION, storedAt: Date.now() })
      .catch(() => { /* a session without storage still gets a renderer */ });
  }

  onProgress('starting the renderer');
  api = await run(bytes);
  return api;
}

/** Evaluate the bundle and hand back its API. */
async function run(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = resolve;
      script.onerror = () => reject(new Error(
        'the browser refused to run the downloaded renderer, which a Content-Security-Policy '
        + 'forbidding blob: scripts would do'));
      document.head.appendChild(script);
    });
  } finally {
    URL.revokeObjectURL(url);
  }

  const namespace = globalThis[GLOBAL]?.mermaid;
  const found = typeof namespace?.initialize === 'function' ? namespace : namespace?.default;
  if (typeof found?.render !== 'function') {
    throw new Error('the downloaded file ran but exposed no mermaid API, so it is not the build this expects');
  }

  found.initialize({
    startOnLoad: false,
    // `strict` sanitises label text, and `htmlLabels: false` keeps labels
    // as SVG `<text>` rather than HTML inside `<foreignObject>`. The second
    // matters more than the first here: a diagram is adopted into this
    // page's DOM, and SVG text is a far smaller surface to have to trust
    // than arbitrary HTML would be.
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: prefersDark() ? 'dark' : 'default',
  });
  return found;
}

function prefersDark() {
  try {
    return !!globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  } catch {
    return false;
  }
}

let sequence = 0;

/**
 * Render Mermaid source to an SVG element.
 *
 * Mermaid hands back markup as a *string*, and this page has a standing
 * rule that nothing reaches the DOM as HTML — `el()` takes strings and
 * makes text nodes, which is why a notebook cannot smuggle markup in. So
 * the string is parsed as `image/svg+xml`, which is a document rather than
 * an innerHTML assignment, and then scrubbed before it is adopted.
 *
 * The input today is the Lab's own generated topology text, so the scrub
 * is defence in depth rather than the only thing standing between a
 * notebook and the page. It is written as though it were the latter,
 * because the day someone renders a fence out of a downloaded notebook it
 * will be.
 *
 * @returns {Promise<SVGElement>}
 */
export async function renderMermaid(source) {
  if (!api) throw new Error('the diagram renderer is not loaded');
  sequence += 1;
  const { svg } = await api.render(`lab-mermaid-${sequence}`, source);
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.nodeName === 'parsererror' || root.querySelector('parsererror')) {
    throw new Error('the renderer produced something that is not SVG');
  }
  scrub(root);
  return document.importNode(root, true);
}

/**
 * Remove everything in a parsed SVG that could act rather than draw.
 *
 * A deny list is the wrong shape for this in general, and it is the right
 * shape here for one reason: what is being scrubbed is the output of a
 * renderer we chose and pinned, not arbitrary input. An allow list over
 * SVG's element set would be longer, would need updating whenever mermaid
 * used a shape it had not used before, and would fail closed by silently
 * dropping parts of a diagram.
 */
function scrub(root) {
  for (const node of [...root.querySelectorAll('script, foreignObject, iframe, object, embed, use')]) {
    node.remove();
  }
  const walk = (node) => {
    for (const attribute of [...node.attributes ?? []]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      // Event handlers, and any link that leaves the document. A fragment
      // is kept because that is how SVG points at its own `<defs>`.
      if (name.startsWith('on')) node.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
        node.removeAttribute(attribute.name);
      } else if (/^(javascript|data):/i.test(value) && !name.startsWith('data-')) {
        node.removeAttribute(attribute.name);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
}
