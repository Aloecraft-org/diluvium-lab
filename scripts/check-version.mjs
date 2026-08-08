// package.json and src/version.js must agree.
//
// Two places name the Lab's version because they serve different readers:
// npm wants package.json, and the page cannot read it (no build step, no
// fetch at load). Two sources of one truth drift silently, so this makes
// the drift loud instead.

import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const src = await readFile(new URL('src/version.js', root), 'utf8');
const declared = /export const LAB_VERSION = '([^']+)'/.exec(src)?.[1];

if (!declared) {
  console.error('check-version: could not find LAB_VERSION in src/version.js');
  process.exit(1);
}
if (declared !== pkg.version) {
  console.error('check-version: the two version sources disagree');
  console.error(`  package.json    ${pkg.version}`);
  console.error(`  src/version.js  ${declared}`);
  process.exit(1);
}
// Semver, so it sorts. `0.2.0_rc1` does not; `0.2.0-rc.1` does.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(declared)) {
  console.error(`check-version: "${declared}" is not semver`);
  process.exit(1);
}
console.log(`check-version: ${declared}`);
