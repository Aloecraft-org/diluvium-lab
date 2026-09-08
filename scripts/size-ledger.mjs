// What the Lab weighs, as one row of the README's ledger.
//
// Plan-2026-09 C1 asks for the web profile's size before the numeric work
// and after each pin move, gzipped, kept in one table. The measurement is
// here rather than in the commit message because a number nobody can
// re-take is a claim: run this, paste the row, and the next person can
// check it.
//
// gzip -9 because that is what a static host serves and what the 500 KB
// threshold in C1 is about; brotli would be a different, better number
// against a different question.
//
//   node scripts/size-ledger.mjs        # needs `npm run bake` for the last column
//
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);

const COLUMNS = [
  'vendor/libdiluvium_wasi.wasm',
  'vendor/diluvium_swarm_wasi.wasm',
  'dist/diluvium-lab.html',
];

const group = (n) => n.toLocaleString('en-US');

async function measure(path) {
  try {
    await stat(new URL(path, root));
  } catch {
    return null;
  }
  const bytes = await readFile(new URL(path, root));
  return { raw: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
}

const pin = (await readFile(new URL('vendor/PINNED_TAG', root), 'utf8')).trim();
const cells = [];
for (const path of COLUMNS) {
  const size = await measure(path);
  if (!size) {
    cells.push('not built');
    console.error(`size-ledger: ${path} is missing (run \`npm run bake\`?)`);
    continue;
  }
  cells.push(`${group(size.raw)} / ${group(size.gz)}`);
}

console.log(`| \`${pin}\` | ${cells.join(' | ')} |`);
