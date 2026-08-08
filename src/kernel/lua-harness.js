// The Lua side of the kernel.
//
// `run_lua` is a blunt instrument: it takes a NUL-terminated string, runs it
// with luaL_dostring, discards the chunk's results, prints its own
// "Error: ..." line to *stdout* on failure, and returns non-zero. Stage 0
// measured all of that. Two consequences drive this file:
//
//   1. Expression echo cannot be done by prepending `return` host-side.
//      The chunk compiles, but nothing is printed, because the results are
//      thrown away. The value has to be printed from inside Lua.
//   2. Since we are already wrapping the user's code in Lua to do that, the
//      error path comes free and comes *structured* -- an xpcall handler
//      yields the message and a traceback as data, which beats scraping the
//      "Error:" line back out of stdout. That is the difference between an
//      `error` message with an ename and a string match that breaks the
//      first time the runtime rewords itself.
//
// So every request runs inside a harness chunk that reports back through a
// length-prefixed record on stdout, tagged with a per-request nonce. User
// output is everything before the nonce; the record is everything after.
// Length-prefixing means the payload can contain anything at all, including
// newlines, tabs and the separator itself.

/** Record kinds the harness can emit. */
export const RECORD = {
  COMPILE_ERROR: 'C',
  RUNTIME_ERROR: 'E',
  RESULT: 'R',
  OK: 'K',
  IS_COMPLETE: 'I',
  MATCHES: 'M',
  LANGUAGE: 'L',
  BYTECODE: 'B',
};

/**
 * Words offered to the kernel's reserved-word probe. A superset on purpose:
 * anything not reserved by the running build is simply reported back as an
 * ordinary identifier, so guessing wide costs nothing and guessing narrow
 * would miss a keyword a newer build added.
 */
export const KEYWORD_CANDIDATES = [
  // stock Lua 5.4
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while',
  // the 5.5 language work, and neighbours worth asking about
  'switch', 'case', 'default', 'continue', 'fallthrough', 'when', 'match',
  'defer', 'const', 'global', 'let', 'var', 'class', 'new', 'struct', 'enum',
  'import', 'export', 'try', 'catch', 'finally', 'async', 'await', 'yield',
  'unless', 'loop', 'each', 'with', 'where', 'type',
];

/**
 * Keywords that are keywords only in statement position, with a snippet
 * that parses if and only if the build has them.
 *
 * Diluvium 5.5 introduces these as *contextual* keywords precisely so
 * that they stay usable as variable names, which is why the identifier
 * probe above cannot see them. Each snippet is one the compiler's own
 * lookahead test accepts: `switch (`, `switch "s"` and `switch {}` are
 * deliberately still function calls, so the probes avoid those shapes.
 *
 * Verified both ways against real builds -- every snippet compiles on
 * 5.5.1 and fails on 5.4.7.
 */
export const CONTEXTUAL_CANDIDATES = [
  ['switch', 'switch x do end'],
  ['defer', 'defer do end'],
  ['with', 'with x = 1 do end'],
  // `global` is reserved outright unless the build sets LUA_COMPAT_GLOBAL,
  // which the shipped 5.5.1 does -- so it needs both probes to be safe,
  // and appears in the list above as well.
  ['global', 'global x = 1'],
];

const SEP = '\u0001';

export function makeNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `DL${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Embed arbitrary text as a Lua long-bracket string, exactly -- the value
 * Lua sees is the text, with nothing added or removed.
 *
 * The level is one higher than the longest `]=*` run anywhere in the text,
 * counted whether or not a `]` follows it. Counting the runs that *do not*
 * close is what makes the closer safe: text ending in `]==` sits directly
 * against `]===]`, and if the levels matched, the string would end three
 * characters early and the rest would be parsed as code.
 *
 * The leading newline is required and free: Lua drops a newline immediately
 * after the opening bracket, so it costs nothing and it keeps text that
 * genuinely starts with a newline intact.
 */
export function luaLongString(text) {
  let level = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ']') continue;
    let j = i + 1;
    while (text[j] === '=') j++;
    level = Math.max(level, j - i); // 1 + however many '=' followed
  }
  const eq = '='.repeat(level);
  return `[${eq}[\n${text}]${eq}]`;
}

/** `io.write(nonce, SEP, kind, SEP, #payload, SEP, payload)` */
function emit(kind, payloadExpr) {
  return `io.write(__N, "\\1", "${kind}", "\\1", tostring(#${payloadExpr}), "\\1", ${payloadExpr})`;
}

/**
 * Show a table's contents instead of its address.
 *
 * `tostring({1, 2, 3})` is `table: 0x1f2e0`, which is the moment a language
 * starts to feel hostile to someone learning it. This renders the value
 * instead, and it runs inside Lua because that is the only place the value
 * exists -- the host only ever sees a string.
 *
 * Applied to the **echo** and nothing else. `print` stays exactly as Lua
 * defines it: a notebook that quietly redefined it would teach people
 * something that stops being true the moment they run the same code in the
 * terminal. Out[n] is the notebook's own affordance and is fair game.
 *
 * Deliberately conservative: `__tostring` wins if a table defines one,
 * recursion is depth- and width-capped, and cycles are reported rather than
 * followed. Every metamethod call is wrapped, because rendering a value
 * must never be what breaks a cell that otherwise ran fine.
 */
const RENDER_LUA = `
local __MAX_DEPTH, __MAX_ITEMS, __MAX_STR = 4, 40, 200
local function __ident(__k)
  return type(__k) == "string" and __k:match("^[A-Za-z_][A-Za-z0-9_]*$") ~= nil
end
-- %q escapes a newline as backslash-newline, which is valid Lua source and
-- awful to read on one line. char(92) is a backslash; writing it that way
-- keeps this readable through two layers of quoting.
local function __quote(__s)
  return (string.format("%q", __s):gsub(string.char(92, 10), string.char(92) .. "n"))
end
-- \`local function\` so it can recurse without becoming a global. A helper
-- of ours turning up in the user's _G would show in completion and in any
-- loop over globals, which is the sort of thing that makes a tool feel
-- like it is leaking.
local function __render(__v, __depth, __seen)
  local __t = type(__v)
  if __t == "string" then
    -- Bare at the top level, matching what the REPL prints, but quoted once
    -- nested: inside a table, "1" and 1 have to be tellable apart.
    if __depth <= 1 then return __v end
    if #__v > __MAX_STR then return __quote(__v:sub(1, __MAX_STR)) .. "..." end
    return __quote(__v)
  end
  if __t ~= "table" then return tostring(__v) end

  local __ok, __mt = pcall(getmetatable, __v)
  if __ok and __mt and __mt.__tostring then
    local __good, __s = pcall(tostring, __v)
    if __good then return __s end
  end
  if __seen[__v] then return "<cycle>" end
  if __depth > __MAX_DEPTH then return "{...}" end
  __seen[__v] = true

  local __parts, __count, __more = {}, 0, false
  -- array part first, in order
  local __n = 0
  local __lenOk, __len = pcall(function() return #__v end)
  if __lenOk then __n = __len end
  for __i = 1, __n do
    if __count >= __MAX_ITEMS then __more = true break end
    __parts[#__parts + 1] = __render(__v[__i], __depth + 1, __seen)
    __count = __count + 1
  end
  -- then the rest, sorted so the same table always reads the same way
  local __keys = {}
  local __iterOk = pcall(function()
    for __k in pairs(__v) do
      if not (type(__k) == "number" and __k % 1 == 0 and __k >= 1 and __k <= __n) then
        __keys[#__keys + 1] = __k
      end
    end
  end)
  if __iterOk then
    pcall(table.sort, __keys, function(__a, __b) return tostring(__a) < tostring(__b) end)
    for _, __k in ipairs(__keys) do
      if __count >= __MAX_ITEMS then __more = true break end
      local __label = __ident(__k) and __k or ("[" .. __render(__k, __depth + 1, __seen) .. "]")
      __parts[#__parts + 1] = __label .. " = " .. __render(__v[__k], __depth + 1, __seen)
      __count = __count + 1
    end
  end

  __seen[__v] = nil
  if __more then __parts[#__parts + 1] = "..." end
  if #__parts == 0 then return "{}" end
  return "{ " .. table.concat(__parts, ", ") .. " }"
end
`;

export function executeChunk(code, nonce) {
  return `local __N = "${nonce}"
local __src = ${luaLongString(code)}
${RENDER_LUA}

-- Finding the value to echo, in three attempts.
--
-- 1. The whole cell is one expression -- "1 + 1".
-- 2. The cell ends in one -- statements, then a bare "counter" on the last
--    line. This is the ordinary notebook idiom and plain Lua rejects it,
--    since an expression is not a statement.
-- 3. Neither, so it is just a chunk and there is nothing to echo.
--
-- Attempt 2 is done by compiling the *whole* source with "return " spliced
-- in before the trailing expression, never by running the two halves
-- separately: a local declared earlier in the cell has to still be in scope.
-- The guard is that the prefix must itself be a complete chunk. Without it,
-- "for i = 1, 3 do / print(i) / end" would split inside the loop body and
-- turn the first iteration into an early return -- printing 1 instead of
-- 1, 2, 3. Requiring a valid prefix rejects every split inside a block.
--
-- Candidates are every token start, walked from the end backwards, not just
-- line starts. Line starts alone miss the whole single-line form --
-- "local t = {3,1,2} table.sort(t) t" -- which failed with a syntax error
-- pointing at <eof>, about as unhelpful as a first-day error gets.
--
-- Splitting mid-string or mid-comment is not a hazard that needs its own
-- check: the prefix would not compile, and every candidate has to compile.
local __f, __e = load("return " .. __src, "=cell", "t")
if not __f then
  -- One past the end: the trailing expression is very often the final
  -- character ("... table.sort(t) t"), and starting the scan at #__src - 1
  -- skips exactly that case.
  local __at = #__src + 1
  local __tried = 0
  while __at > 2 and __tried < 200 do
    -- previous token start: a non-space preceded by a space or a separator
    local __start = nil
    for __i = __at - 1, 2, -1 do
      local __c = __src:sub(__i, __i)
      local __p = __src:sub(__i - 1, __i - 1)
      if __c:match("%S") and (__p:match("%s") or __p == ";") then __start = __i break end
    end
    if not __start then break end
    __at = __start

    local __prefix = __src:sub(1, __start - 1)
    local __suffix = __src:sub(__start)
    __tried = __tried + 1
    if __suffix:match("%S") and load(__prefix, "=cell", "t") then
      -- "return " is spliced in place, so a later error still reports the
      -- line and column the user actually typed.
      local __cand = load(__prefix .. "return " .. __suffix, "=cell", "t")
      if __cand then __f = __cand break end
    end
  end
end
if not __f then
  local __g, __e2 = load(__src, "=cell", "t")
  if __g then
    __f = __g
  else
    local __m = tostring(__e2)
    ${emit(RECORD.COMPILE_ERROR, '__m')}
    return
  end
end
local __r = table.pack(xpcall(__f, function(__err)
  return tostring(__err) .. "\\1" .. debug.traceback("", 2)
end))
if not __r[1] then
  local __m = tostring(__r[2])
  ${emit(RECORD.RUNTIME_ERROR, '__m')}
  return
end
if __r.n > 1 then
  local __parts = {}
  for __i = 2, __r.n do __parts[#__parts + 1] = __render(__r[__i], 1, {}) end
  local __s = table.concat(__parts, "\\t")
  ${emit(RECORD.RESULT, '__s')}
else
  local __s = ""
  ${emit(RECORD.OK, '__s')}
end
`;
}


/**
 * Lua's own REPL rule: a chunk that fails to compile with an error ending in
 * `<eof>` ran out of input rather than being wrong, so the console should
 * keep taking lines instead of reporting a syntax error.
 */
export function isCompleteChunk(code, nonce) {
  return `local __N = "${nonce}"
local __src = ${luaLongString(code)}
local function __eof(__e)
  return type(__e) == "string" and __e:sub(-5) == "<eof>"
end
-- Both attempts matter. "1 +" only runs out of input in the expression
-- form, and "function f()" only in the statement form; keeping just the
-- second error calls the first one invalid and makes the console refuse to
-- take a continuation line.
local __f, __e1 = load("return " .. __src, "=cell", "t")
local __e2
if not __f then __f, __e2 = load(__src, "=cell", "t") end
local __s
if __f then
  __s = "complete"
elseif __eof(__e1) or __eof(__e2) then
  __s = "incomplete"
else
  __s = "invalid"
end
${emit(RECORD.IS_COMPLETE, '__s')}
`;
}

/**
 * Completion, done the way the Diluvium handoff wants it: the logic is Lua,
 * embedded, and reached through the same `run_lua` door as everything else.
 * `base` is the part before the final `.`/`:` (possibly empty) and `part` is
 * the fragment being typed.
 */
export function completeChunk(base, part, nonce) {
  return `local __N = "${nonce}"
local __base = ${luaLongString(base)}
local __part = ${luaLongString(part)}
local __seen, __out = {}, {}
local function __add(__k)
  if type(__k) == "string" and __k:sub(1, #__part) == __part and not __seen[__k] then
    __seen[__k] = true
    __out[#__out + 1] = __k
  end
end
local __t
if __base == "" then
  __t = _G
  for __k in ("and break do else elseif end false for function goto if in local nil " ..
              "not or repeat return then true until while"):gmatch("%S+") do __add(__k) end
else
  local __loader = load("return " .. __base, "=complete", "t")
  if __loader then
    local __ok, __v = pcall(__loader)
    if __ok then __t = __v end
  end
end
-- walk one __index hop so methods on a metatable show up too
local __depth = 0
while type(__t) == "table" and __depth < 4 do
  for __k in pairs(__t) do __add(__k) end
  local __mt = getmetatable(__t)
  __t = __mt and __mt.__index or nil
  __depth = __depth + 1
end
table.sort(__out)
local __s = table.concat(__out, "\\n")
${emit(RECORD.MATCHES, '__s')}
`;
}

/**
 * Compile a cell and hand back its bytecode, as hex.
 *
 * Hex rather than the raw bytes, for a reason that is not squeamishness:
 * the harness reports through stdout, which the shim decodes as UTF-8, and
 * compiled Lua is full of bytes that are not valid UTF-8. They would be
 * replaced with U+FFFD somewhere in the middle and the chunk would be
 * quietly corrupt. Hex doubles the size of something that is a few hundred
 * bytes, and it is also the format people paste around, so it earns its
 * place twice.
 *
 * `strip` drops line numbers, local names and upvalue names -- the thing to
 * toggle when the question is "what does the debug information cost".
 */
export function dumpChunk(code, nonce, { strip = false } = {}) {
  return `local __N = "${nonce}"
local __src = ${luaLongString(code)}
local __f, __e = load(__src, "=cell", "t")
if not __f then
  local __m = tostring(__e)
  ${emit(RECORD.COMPILE_ERROR, '__m')}
  return
end
local __ok, __dump = pcall(string.dump, __f, ${strip ? 'true' : 'false'})
if not __ok then
  local __m = tostring(__dump)
  ${emit(RECORD.RUNTIME_ERROR, '__m')}
  return
end
local __hex = {}
for __i = 1, #__dump do __hex[__i] = string.format("%02x", __dump:byte(__i)) end
local __s = table.concat(__hex)
${emit(RECORD.BYTECODE, '__s')}
`;
}

/**
 * Ask the kernel what its own language looks like, so the highlighter
 * colours the build that is actually running.
 *
 * Reserved words cannot be probed by enumeration -- Lua exposes no list --
 * so a candidate superset is offered and each one is tested by trying to
 * use it as an identifier. 5.4.7 reserves exactly stock Lua's 22.
 *
 * That test alone is not enough for 5.5, and the reason is a deliberate
 * design decision in the compiler rather than an oversight here.
 * Diluvium 5.5 adds `switch`, `defer`, `with` and `global` as
 * **contextual** keywords: recognised only at the start of a statement,
 * and left as ordinary identifiers everywhere else, so that existing code
 * with a variable called `switch` keeps working. `local switch = 1`
 * therefore compiles on 5.5, and an identifier probe concludes -- quite
 * correctly, and uselessly -- that `switch` is not reserved.
 *
 * So a second probe compiles a snippet that only parses if the word *is* a
 * statement keyword. `switch x do end` is a syntax error on 5.4.7 and a
 * switch statement on 5.5.1. This does mean the Lab knows a little 5.5
 * grammar, which is the cost of a keyword that is not a reserved word;
 * the list degrades safely, since a snippet that does not compile simply
 * adds nothing.
 *
 * Globals need no candidates: `_G` enumerates.
 */
export function languageInfoChunk(candidates, nonce) {
  const list = candidates.map((w) => `"${w}"`).join(', ');
  const contextual = CONTEXTUAL_CANDIDATES
    .map(([word, snippet]) => `{ "${word}", ${luaLongString(snippet)} }`).join(', ');
  return `local __N = "${nonce}"
local __reserved, __seen = {}, {}
local function __keyword(__w)
  if not __seen[__w] then
    __seen[__w] = true
    __reserved[#__reserved + 1] = __w
  end
end
for _, __w in ipairs({ ${list} }) do
  if not load("local " .. __w .. " = 1", "=probe", "t") then __keyword(__w) end
end
-- A word can be reserved outright or contextual depending on how the
-- build was configured, so both probes run and the set absorbs the
-- overlap.
for _, __p in ipairs({ ${contextual} }) do
  if load(__p[2], "=probe", "t") then __keyword(__p[1]) end
end
local __globals = {}
for __k in pairs(_G) do
  if type(__k) == "string" then __globals[#__globals + 1] = __k end
end
table.sort(__reserved)
table.sort(__globals)
local __s = _VERSION .. "\\1" .. table.concat(__reserved, " ") .. "\\1" .. table.concat(__globals, " ")
${emit(RECORD.LANGUAGE, '__s')}
`;
}

/**
 * Split raw stdout into the user's output and the harness record.
 *
 * A missing record is not a parse failure -- it means the harness never got
 * to the end (a trap, or proc_exit), and the caller decides what that means.
 */
export function parseRecord(stdout, nonce) {
  const at = stdout.indexOf(nonce);
  if (at === -1) return { output: stdout, record: null };

  const output = stdout.slice(0, at);
  // Everything after the nonce is SEP kind SEP length SEP payload, so the
  // first character is the separator itself.
  const rest = stdout.slice(at + nonce.length);
  if (!rest.startsWith(SEP)) return { output, record: null };

  const kindEnd = rest.indexOf(SEP, 1);
  if (kindEnd === -1) return { output, record: null };
  const lenEnd = rest.indexOf(SEP, kindEnd + 1);
  if (lenEnd === -1) return { output, record: null };

  const kind = rest.slice(1, kindEnd);
  const length = Number.parseInt(rest.slice(kindEnd + 1, lenEnd), 10);
  if (!Number.isInteger(length) || length < 0) return { output, record: null };

  return { output, record: { kind, payload: rest.slice(lenEnd + 1, lenEnd + 1 + length) } };
}

/** Runtime-error payloads carry `message  traceback`. */
export function splitPayload(payload) {
  return payload.split(SEP);
}

/** Runtime-error payloads carry `message` then the traceback. */
export function splitTraceback(payload) {
  const at = payload.indexOf(SEP);
  if (at === -1) return { message: payload, traceback: '' };
  return { message: payload.slice(0, at), traceback: payload.slice(at + 1) };
}
