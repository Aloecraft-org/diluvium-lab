// SHA-256, and an honest answer when the browser will not do it.

/**
 * `crypto.subtle` only exists in a secure context. https and localhost
 * qualify; a page opened from `file://` does not, which is exactly the
 * baked single-file build. That build carries its kernel inside it and has
 * nothing to download, so the right behaviour there is to refuse to fetch
 * rather than to fetch without checking.
 */
export function canVerify() {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export async function sha256Hex(bytes) {
  if (!canVerify()) {
    throw new Error(
      'this page cannot compute checksums, because crypto.subtle needs a secure ' +
      'context (https or localhost). Downloading a runtime without verifying it ' +
      'is not an option, so version switching is off here.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
