// What this build of the Lab is.
//
// Hand-maintained, because the served page has no build step and there is
// nowhere for a generated value to come from. One line, bumped when a
// release is tagged; `npm run bake` stamps the commit into the baked file,
// where a build step does exist.
//
// ## The scheme
//
// Plain semver, and the Lab's number is the Lab's own -- it does not track
// Diluvium's. They move independently and pinning one to the other would
// mean either lying about one of them or being unable to ship a fix.
// Which Diluvium is bundled is a separate fact, recorded in
// `vendor/pinned.js` and shown beside this in the About panel.
//
//   MAJOR  a notebook saved by the old version stops opening in the new
//          one, or a documented interface changes shape
//   MINOR  new capability
//   PATCH  fixes only
//
// Pre-release suffixes are semver's: `0.2.0-rc.1`. Note the hyphen and
// the dot -- `0.2.0_rc1` is not semver and does not sort.

export const LAB_VERSION = '0.12.0';

/**
 * The commit this was built from, or null when it cannot be known.
 *
 * Null is the honest answer for a page served straight from a checkout:
 * nothing has run that could have looked at git. `scripts/bake.mjs`
 * replaces this line in the baked output, and a deployment can do the
 * same. The About panel says "unknown" rather than inventing something.
 */
export const LAB_COMMIT = (typeof window !== 'undefined' && window.DILUVIUM_LAB_COMMIT) || null;
