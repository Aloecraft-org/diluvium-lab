// package.json and src/version.js must agree.
//
// Three places name the Lab's version because they serve different
// readers: npm wants package.json, the page cannot read it (no build step,
// no fetch at load), and index.html carries a copy so the running page can
// notice when its HTML and its scripts came from different deploys. Three
// sources of one truth drift silently, so this makes the drift loud.

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

console.log(`check-version: ${declared} (package.json, src/version.js, index.html)`);
