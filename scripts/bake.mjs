#!/usr/bin/env node
// Bake the Lab into one HTML file you can double-click.
//
//   node scripts/bake.mjs [outfile]     default: dist/diluvium-lab.html
//
// The served page stays the source of truth. This is a second artifact for
// the double-click case, and it exists because a browser will not `fetch`
// over `file://` -- so the kernel has to be *in* the file rather than next
// to it. That costs ~1.2 MB of base64 and a re-bake on every version bump,
// which is why it is a build output and not the thing being developed.
//
// Deliberately not a bundler. It resolves the module graph, concatenates it
// in dependency order, and strips the import/export syntax that only means
// something across module boundaries. If it meets a form it does not
// understand it stops rather than guessing -- a silently mistranslated
// bundle is worse than no bundle. The proof that it worked is
// test/bake.spec.js, which opens the output over file:// and runs a cell.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_HTML = resolve(ROOT, 'index.html');
const WASM = resolve(ROOT, 'vendor/libdiluvium_wasi.wasm');
const OUT = resolve(ROOT, process.argv[2] ?? 'dist/diluvium-lab.html');

class BakeError extends Error {}

/** Pull the single inline module script out of the page. */
function extractEntryScript(html) {
  const match = /<script\s+type="module"\s*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new BakeError('index.html has no inline <script type="module">');
  if (/<script\s+type="module"/g.test(html.slice(match.index + match[0].length))) {
    throw new BakeError('index.html has more than one module script; bake expects exactly one');
  }
  return { source: match[1], start: match.index, end: match.index + match[0].length };
}

/**
 * Find top-level import statements, including the multi-line form.
 * Returns [{ start, end, specifier }] over the source.
 */
function findImports(source) {
  const found = [];
  const re = /^[ \t]*import\b/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    const from = source.indexOf(' from ', match.index);
    const bare = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?/.exec(source.slice(match.index));
    if (bare) {
      found.push({ start: match.index, end: match.index + bare[0].length, specifier: bare[1] });
      re.lastIndex = match.index + bare[0].length;
      continue;
    }
    if (from === -1) throw new BakeError(`unparsable import near: ${snippet(source, match.index)}`);
    const quote = /\s*['"]([^'"]+)['"]\s*;?/.exec(source.slice(from + 6));
    if (!quote) throw new BakeError(`unparsable import specifier near: ${snippet(source, match.index)}`);
    const end = from + 6 + quote[0].length;
    found.push({ start: match.index, end, specifier: quote[1] });
    re.lastIndex = end;
  }
  return found;
}

function snippet(source, at) {
  return JSON.stringify(source.slice(at, at + 60));
}

/**
 * Drop import statements and the `export` keyword. Everything lands in one
 * module scope, so `export` stops meaning anything -- but `export default`
 * and `export { ... }` would need real renaming, so they are refused.
 */
function stripModuleSyntax(source, imports, file) {
  let out = '';
  let at = 0;
  for (const imp of imports) {
    out += source.slice(at, imp.start);
    at = imp.end;
  }
  out += source.slice(at);

  if (/^[ \t]*export\s+default\b/m.test(out)) {
    throw new BakeError(`${file}: 'export default' cannot be flattened; use a named export`);
  }
  if (/^[ \t]*export\s*\{/m.test(out)) {
    throw new BakeError(`${file}: 'export { ... }' cannot be flattened; export at the declaration`);
  }
  if (/^[ \t]*export\s+\*/m.test(out)) {
    throw new BakeError(`${file}: 'export *' cannot be flattened`);
  }
  return out.replace(/^([ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '$1');
}

/** Names a flattened module contributes to the shared scope. */
function topLevelNames(source) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let match;
  while ((match = re.exec(source)) !== null) names.add(match[1]);
  return names;
}

const modules = new Map();   // absolute path -> { code, deps }
const order = [];

async function collect(file) {
  if (modules.has(file)) return;
  modules.set(file, null);                 // cycle guard

  const source = await readFile(file, 'utf8');
  const imports = findImports(source);
  const deps = imports
    .filter((i) => i.specifier.startsWith('.'))
    .map((i) => resolve(dirname(file), i.specifier));

  for (const imp of imports) {
    if (!imp.specifier.startsWith('.')) {
      throw new BakeError(`${relative(ROOT, file)}: cannot inline the bare specifier '${imp.specifier}'`);
    }
  }
  for (const dep of deps) await collect(dep);

  modules.set(file, { code: stripModuleSyntax(source, imports, relative(ROOT, file)), deps });
  order.push(file);                        // post-order: dependencies first
}

async function main() {
  const html = await readFile(ENTRY_HTML, 'utf8');
  const entry = extractEntryScript(html);

  const entryImports = findImports(entry.source);
  for (const imp of entryImports) await collect(resolve(ROOT, dirname(ENTRY_HTML), imp.specifier));
  const entryCode = stripModuleSyntax(entry.source, entryImports, 'index.html');

  // One shared scope means one namespace. A collision would silently
  // shadow, so refuse instead.
  const seen = new Map();
  for (const file of order) {
    for (const name of topLevelNames(modules.get(file).code)) {
      if (seen.has(name)) {
        throw new BakeError(
          `'${name}' is declared at top level in both ${seen.get(name)} and ` +
          `${relative(ROOT, file)}; flattening them would shadow one`);
      }
      seen.set(name, relative(ROOT, file));
    }
  }

  const wasm = await readFile(WASM);
  const base64 = wasm.toString('base64');

  const bundle = [
    '// Generated by scripts/bake.mjs -- do not edit. Edit index.html and src/.',
    `window.DILUVIUM_KERNEL_BASE64 = ${JSON.stringify(base64)};`,
    ...order.map((file) => `\n// ---- ${relative(ROOT, file)} ----\n${modules.get(file).code}`),
    `\n// ---- index.html ----\n${entryCode}`,
  ].join('\n');

  const baked = html.slice(0, entry.start)
    + `<script type="module">\n${bundle}\n</script>`
    + html.slice(entry.end);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, baked);

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
  console.log(`baked ${relative(ROOT, OUT)}`);
  console.log(`  ${order.length + 1} modules, kernel inlined (${mb(wasm.length)} -> ${mb(base64.length)} of base64)`);
  console.log(`  ${mb(baked.length)} total`);
}

main().catch((err) => {
  console.error(err instanceof BakeError ? `bake failed: ${err.message}` : err);
  process.exit(1);
});
