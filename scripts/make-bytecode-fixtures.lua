-- Generate 5.5 bytecode fixtures for test/bytecode-5.5.spec.js.
--
-- The Lab consumes Diluvium; it does not build it. But the 5.5 container
-- reader had to be written from `ldump.c` rather than from bytes, and a
-- container reader checked only against its own author's understanding is
-- not checked at all. So: build the native 5.5.1 interpreter once, dump
-- real chunks with it, and commit the bytes.
--
--   gcc -O1 -std=gnu99 -DLUA_USE_LINUX -o lua5.5 <diluvium>/src/*.c   (minus
--   luac.c, onelua.c, wasm_stubs*.c, ltests.c)
--   ./lua5.5 scripts/make-bytecode-fixtures.lua > test/fixtures/bytecode-5.5.json
--
-- Regenerate whenever a Diluvium release changes the dump format. The
-- fixtures are the record of what a real build actually emitted.

local function hex(s)
  return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end))
end

local cases = {
  { name = 'empty',            source = 'return 1' },
  { name = 'globals',          source = 'print("hi")' },
  { name = 'add',              source = 'local function add(a, b) return a + b end' },
  { name = 'siblings',         source = 'local function a(x) return x end local function b(x) return x end return a, b' },
  { name = 'nested',           source = 'local function a() local function b() return 1 end return b end return a' },
  { name = 'numeric for',      source = 'for i = 1, 10 do print(i) end' },
  { name = 'table',            source = 'return { 1, 2, 3, name = "x", other = "y" }' },
  { name = 'vararg',           source = 'return function(...) return ... end' },
  { name = 'tailcall',         source = 'local function loop() return loop() end' },
  -- Integer constants are zigzag varints in 5.5, so the extremes matter:
  -- maxinteger zigzags to 2^64 - 2, which a JS number cannot hold.
  { name = 'big integers',
    source = 'return 9223372036854775807, 0x8000000000000000, -4294967296, 4294967296' },
  { name = 'floats',           source = 'return 1.5, -0.25, 1e308' },
  { name = 'long string',      source = 'return "' .. string.rep('x', 300) .. '"' },
  { name = 'empty string',     source = 'local x = "" return x .. "tail"' },
  { name = 'repeated strings', source = 'local a = "same" local b = "same" return a, b' },

  -- The Diluvium-only part: `~function` marks a proto secure, and
  -- everything lexically inside it inherits.
  { name = 'secure',           source = 'local ~function s() return "inside" end return s' },
  { name = 'secure nested',    source = 'local ~function s() local function inner() return "deep" end return inner end return s' },
  { name = 'secure sibling',
    source = 'local ~function s() return "secure-only-literal" end '
      .. 'local function p() return "plain-only-literal" end return s, p' },
  { name = 'secure vararg',    source = 'local ~function s(...) local n = select("#", ...) return n end return s' },
  { name = 'secure table',     source = 'local ~function s() return { 1, 2, k = "v" } end return s' },

  -- The interning question: does a literal shared with an enclosing
  -- plain function still get scrambled inside the secure one?
  { name = 'secure shared literal',
    source = 'local outer = "shared-secret" local ~function s() return "shared-secret" end return outer, s' },

  -- 5.4.7 marked the first nested function and its subtree secure whether
  -- or not anyone asked. 5.5 made it opt-in, so a chunk with no `~` in it
  -- should have no secure protos at all.
  { name = 'no tilde anywhere',
    source = 'local function a() local function a1() return "one" end return a1 end '
      .. 'local function b() return "two" end return a, b' },
}

local out = {}
out[#out + 1] = '{'
out[#out + 1] = '  "lua": "' .. _VERSION .. '",'
out[#out + 1] = '  "cases": ['

for i, case in ipairs(cases) do
  local f = assert(load(case.source, '=fixture', 't'))
  local plain = string.dump(f)
  local stripped = string.dump(f, true)
  out[#out + 1] = string.format(
    '    { "name": %q, "source": %q,\n      "hex": "%s",\n      "strippedHex": "%s" }%s',
    case.name, case.source, hex(plain), hex(stripped), i < #cases and ',' or '')
end

out[#out + 1] = '  ]'
out[#out + 1] = '}'
print(table.concat(out, '\n'))
