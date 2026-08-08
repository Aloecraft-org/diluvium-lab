// Assert that the baked single file really is self-contained.
//
//   node scripts/check-bake.mjs [file]     default: dist/diluvium-lab.html
//
// "No CDN, no external requests at load" is a hard constraint, and the
// baked page is the one artifact where breaking it would be silent: a
// stray <script src> or an un-inlined kernel still *renders*, and the
// failure only shows up on a machine with no network -- which is exactly
// the machine the baked file exists for.
//
// So this checks the output rather than trusting the bake. It is a
// deliberately dumb text scan: no parsing, no assumptions about how
// bake.mjs works, which is what makes it a check rather than a restatement.

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = resolve(process.cwd(), process.argv[2] ?? 'dist/diluvium-lab.html');

const problems = [];
const note = (ok, message) => { if (!ok) problems.push(message); };

let html;
try {
  html = await readFile(FILE, 'utf8');
} catch {
  console.error(`check-bake: ${FILE} is not there. Run \`npm run bake\` first.`);
  process.exit(1);
}
const { size } = await stat(FILE);

// --- nothing may be loaded from anywhere ------------------------------

const externalTags = [
  [/<script\b[^>]*\bsrc\s*=/gi, '<script src=...>'],
  [/<link\b[^>]*\bhref\s*=/gi, '<link href=...>'],
  [/<img\b[^>]*\bsrc\s*=\s*["']?(?!data:)/gi, '<img src=...> that is not a data: URI'],
  [/@import\b/gi, 'a CSS @import'],
  [/\burl\(\s*["']?https?:/gi, 'a CSS url() pointing at http(s)'],
];
for (const [pattern, what] of externalTags) {
  const hits = html.match(pattern);
  note(!hits, `${hits?.length ?? 0} × ${what} — the baked page must load nothing`);
}

// --- the kernel must be inlined, not fetched --------------------------

note(
  html.includes('window.DILUVIUM_KERNEL_BASE64'),
  'the kernel is not inlined: no window.DILUVIUM_KERNEL_BASE64 in the output');

// A base64 kernel is ~1.1 MB. Anything much smaller means the constant is
// present but empty, which is the failure mode that would otherwise look
// like success.
const inlined = /window\.DILUVIUM_KERNEL_BASE64\s*=\s*"([A-Za-z0-9+/=]*)"/.exec(html);
note(
  inlined && inlined[1].length > 500_000,
  `the inlined kernel is ${inlined ? inlined[1].length : 0} base64 chars, which is too small to be a real module`);

// The un-baked page fetches the kernel from vendor/. The baked one must
// not: if this path survives, the file only works next to a checkout.
note(
  !/fetch\([^)]*vendor\/libdiluvium_wasi\.wasm/.test(html),
  'the baked page still fetches vendor/libdiluvium_wasi.wasm');

// --- and it must be one file ------------------------------------------

note(size > 1_000_000, `the output is only ${size} bytes — too small to contain the kernel`);
note(size < 8_000_000, `the output is ${(size / 1e6).toFixed(1)} MB — unexpectedly large, check for a double inline`);

// ----------------------------------------------------------------------

if (problems.length) {
  console.error(`check-bake: ${FILE}`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`check-bake: ${(size / 1e6).toFixed(2)} MB, self-contained, kernel inlined`);
