// Opening a notebook from a URL.
//
// The Lab makes no request at load — a hard constraint, and this does not
// bend it. Every fetch here is something somebody pressed: the **Open
// URL…** button, or the **Open** button on the bar a `?open=` link raises.
// A link someone sends you is not the same as a decision you made, which
// is why the link form asks first and names the host it would talk to.
//
// Beyond that this is the same trust story as **Open…**: a notebook is
// data, nothing in it reaches the DOM as markup, and its outputs render
// through the same sanitised path as any other. What a URL adds is *where
// it came from*, so that is what the confirmation shows.

import { IpynbError } from './ipynb.js';

/** Bigger than any real notebook, small enough not to hang the tab. */
export const MAX_NOTEBOOK_BYTES = 25 * 1024 * 1024;

export class RemoteError extends Error {}

/**
 * The URL to actually fetch, given what someone pasted.
 *
 * People paste the page they were looking at, which for GitHub is a `blob`
 * URL that serves HTML. Fetching it succeeds and then fails to parse, with
 * an error about JSON that explains nothing. Rewriting it is a one-line
 * kindness and the rule is public and stable.
 *
 * Everything else is returned unchanged: guessing more would mean guessing
 * wrong somewhere, and an honest 404 beats a clever redirect.
 */
export function normaliseNotebookUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new RemoteError('give it a URL');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RemoteError(`this only opens http and https URLs, not ${url.protocol}`);
  }

  // github.com/<owner>/<repo>/blob/<ref>/<path> -> raw.githubusercontent.com
  if (url.hostname === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length > 4 && parts[2] === 'blob') {
      const [owner, repo, , ...rest] = parts;
      return {
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}`,
        rewrittenFrom: url.href,
      };
    }
  }
  return { url: url.href, rewrittenFrom: null };
}

/** Just the host, for a sentence asking whether to talk to it. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Fetch and parse a notebook.
 *
 * The errors are the point of this function. A cross-origin fetch that a
 * server has not opted into fails as an indistinguishable `TypeError` with
 * no status and no detail — the browser refuses to tell a page why, on
 * purpose — so the message has to explain the likely cause rather than
 * repeat "Failed to fetch", which is what sends someone to the devtools
 * console for twenty minutes.
 *
 * @returns {Promise<{text: string, url: string, name: string}>}
 */
export async function fetchNotebook(input, { fetchImpl = fetch } = {}) {
  const { url, rewrittenFrom } = normaliseNotebookUrl(input);

  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow' });
  } catch (cause) {
    throw new RemoteError(
      `could not reach ${hostOf(url)}. Either it is unreachable, or it does not send `
      + '`Access-Control-Allow-Origin`, which a browser needs before it will let this page '
      + 'read the response. `raw.githubusercontent.com` does; a plain `github.com` page does not.',
      { cause });
  }
  if (!response.ok) {
    throw new RemoteError(`${hostOf(url)} answered ${response.status} ${response.statusText}`);
  }

  // Checked before reading where the server said so, and again after, since
  // `content-length` is optional and a chunked response carries none.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_NOTEBOOK_BYTES) {
    throw new RemoteError(`that is ${Math.round(declared / 1e6)} MB, which is too large to open here`);
  }
  const text = await response.text();
  if (text.length > MAX_NOTEBOOK_BYTES) {
    throw new RemoteError('that file is too large to open here');
  }

  // A page rather than a notebook is the common wrong answer, and JSON's
  // own error for it ("Unexpected token '<'") explains nothing.
  if (/^\s*</.test(text)) {
    throw new RemoteError(
      rewrittenFrom
        ? 'that URL served a web page rather than a notebook, even after rewriting it to the raw form'
        : 'that URL served a web page rather than a notebook. On GitHub, use the **Raw** button '
          + '(or a `raw.githubusercontent.com` URL).');
  }

  return { text, url, name: nameFrom(url), rewrittenFrom };
}

/** The last path segment, which is what a notebook should be called. */
export function nameFrom(url) {
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    return last || 'notebook.ipynb';
  } catch {
    return 'notebook.ipynb';
  }
}

/** Re-thrown so callers can treat a bad notebook and a bad fetch alike. */
export function describeOpenError(err) {
  if (err instanceof RemoteError) return err.message;
  if (err instanceof IpynbError) return err.message;
  return `could not open that notebook: ${err.message}`;
}
