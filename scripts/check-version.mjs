// Everything that names the Lab's version must agree, and `.technoproj`
// is the one a human edits.
//
// Five places name it because they serve different readers: `.technoproj`
// is the declared source (doc/Alignment.md §2), npm wants package.json,
// the page cannot read either one (no build step, no fetch at load), and
// index.html carries two copies so the running page can notice when its
// HTML and its scripts came from different deploys. Five sources of one
// truth drift silently, so this makes the drift loud.
//
// The shared changelog engine of Alignment §3 would own the deriving.
// Until it exists this checks rather than generates, which catches the
// same drift a step later and needs no tool the Lab does not have.

import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const src = await readFile(new URL('src/version.js', root), 'utf8');
const declared = /export const LAB_VERSION = '([^']+)'/.exec(src)?.[1];

if (!declared) {
  console.error('check-version: could not find LAB_VERSION in src/version.js');
  process.exit(1);
}

// `.technoproj` is the source, so it is checked first and named as the
// source when something disagrees with it. The spelling is Alignment §1's:
// `<major>.<minor>.<patch>[-<kind>.<n>]`, with the dot before the number,
// because `-dev7` does not sort and `-dev.7` does.
const proj = JSON.parse(await readFile(new URL('.technoproj', root), 'utf8'));
const tv = proj.TECHNO_VERSION ?? {};
for (const key of ['major', 'minor', 'patch']) {
  if (!Number.isInteger(tv[key])) {
    console.error(`check-version: .technoproj TECHNO_VERSION.${key} must be an integer`);
    process.exit(1);
  }
}
if (tv.build !== undefined) {
  console.error('check-version: .technoproj still has the old `build` field; it is `pre` now');
  console.error('  `pre` is null for a release, or {"kind": "rc", "n": 1} for a prerelease.');
  console.error('  See doc/Alignment.md §2 -- `build` meant three different things across repos.');
  process.exit(1);
}
if (tv.pre !== null && tv.pre !== undefined
    && !(typeof tv.pre?.kind === 'string' && Number.isInteger(tv.pre?.n))) {
  console.error('check-version: .technoproj TECHNO_VERSION.pre must be null or {kind, n}');
  process.exit(1);
}
const composed = `${tv.major}.${tv.minor}.${tv.patch}`
  + (tv.pre ? `-${tv.pre.kind}.${tv.pre.n}` : '');
if (composed !== declared) {
  console.error('check-version: .technoproj is the source and nothing else matches it');
  console.error(`  .technoproj     ${composed}`);
  console.error(`  src/version.js  ${declared}`);
  process.exit(1);
}

if (declared !== pkg.version) {
  console.error('check-version: the two version sources disagree');
  console.error(`  package.json    ${pkg.version}`);
  console.error(`  src/version.js  ${declared}`);
  process.exit(1);
}

// package-lock.json names it twice more, and both were stale at 0.11.0 while
// package.json said 0.12.0 -- caught only when the 0.13.0 bump tried to edit
// a string that was not there. There is a commit in this repository called
// "Sync package-lock version field with package.json"; it drifted again at
// the very next bump, which is the argument for checking rather than
// remembering. The dependencies' own versions are none of our business, so
// this reads the two fields that name *this* package.
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
for (const [where, found] of [
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages?.['']?.version],
]) {
  if (found !== declared) {
    console.error('check-version: the lockfile disagrees');
    console.error(`  ${where}  ${found ?? '(missing)'}`);
    console.error(`  src/version.js${' '.repeat(Math.max(0, where.length - 14))}  ${declared}`);
    console.error('  Run: npm install --package-lock-only');
    process.exit(1);
  }
}
// Semver, so it sorts. `0.2.0_rc1` does not; `0.2.0-rc.1` does.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(declared)) {
  console.error(`check-version: "${declared}" is not semver`);
  process.exit(1);
}
const html = await readFile(new URL('index.html', root), 'utf8');
const meta = /<meta name="diluvium-lab-build" content="([^"]+)"/.exec(html)?.[1];
// The inline script is the one that actually shows the banner, and it
// carries its own copy because it must not import anything -- importing is
// the thing that can be stale. So it has to be checked too.
const inline = /var EXPECTED = '([^']+)'/.exec(html)?.[1];
if (inline !== declared) {
  console.error('check-version: the inline check in index.html disagrees with src/version.js');
  console.error(`  index.html inline  ${inline ?? '(missing)'}`);
  console.error(`  src/version.js     ${declared}`);
  console.error('  This is what decides whether every visitor sees a "stale scripts" banner.');
  process.exit(1);
}
if (meta !== declared) {
  console.error('check-version: index.html disagrees with src/version.js');
  console.error(`  index.html      ${meta ?? '(missing)'}`);
  console.error(`  src/version.js  ${declared}`);
  console.error('  These are what the running page compares to detect a stale cache,');
  console.error('  so a mismatch here would make every visitor see a false alarm.');
  process.exit(1);
}

// The import map is what actually decides which URLs the browser fetches,
// so a stale one is not cosmetic -- it would pin the whole graph to an old
// version and defeat the point of stamping it.
const stamped = [...html.matchAll(/\?v=([0-9A-Za-z.+-]+)"/g)].map((m) => m[1]);
const wrong = [...new Set(stamped)].filter((v) => v !== declared);
if (wrong.length) {
  console.error('check-version: index.html\'s import map is stamped with the wrong version');
  console.error(`  found      ${wrong.join(', ')}`);
  console.error(`  expected   ${declared}`);
  console.error('  Run: node scripts/stamp-imports.mjs');
  process.exit(1);
}

// CHANGELOG.yaml is the source of truth for release notes, so a version
// bump with no entry is a release nobody wrote down. Read by regex and not
// by parsing: the Lab has no YAML dependency and this is checking that two
// strings agree, not reading the file's meaning. The engine of Alignment
// §3 does the reading.
const changelog = await readFile(new URL('CHANGELOG.yaml', root), 'utf8');
const first = /^\s*-\s+version:\s*"?([0-9A-Za-z.+-]+)"?\s*$/m.exec(changelog);
if (!first) {
  console.error('check-version: CHANGELOG.yaml has no release entries');
  process.exit(1);
}
if (first[1] !== declared) {
  console.error('check-version: CHANGELOG.yaml\'s newest entry is not this version');
  console.error(`  CHANGELOG.yaml  ${first[1]}`);
  console.error(`  .technoproj     ${declared}`);
  console.error('  A version bump with no changelog entry is a release nobody wrote down.');
  process.exit(1);
}
// Explicit rather than derived, exactly as diluvium's and DRT's files are,
// so this is one more place the file can be caught lying rather than one
// fewer.
const tagLine = new RegExp(`^\\s*-\\s+version:\\s*"?${first[1].replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}"?\\s*\\n\\s+tag:\\s*(\\S+)`, 'm');
const tag = tagLine.exec(changelog)?.[1];
if (tag !== `v${declared}`) {
  console.error('check-version: CHANGELOG.yaml\'s newest entry has the wrong tag');
  console.error(`  tag        ${tag ?? '(missing)'}`);
  console.error(`  expected   v${declared}`);
  process.exit(1);
}

console.log(
  `check-version: ${declared} (.technoproj, package.json, package-lock.json, `
  + `src/version.js, index.html, CHANGELOG.yaml, ${stamped.length} stamped imports)`);
