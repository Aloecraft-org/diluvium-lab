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

export function executeChunk(code, nonce) {
  return `local __N = "${nonce}"
local __src = ${luaLongString(code)}

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
local __f, __e = load("return " .. __src, "=cell", "t")
if not __f then
  local __nl, __i = {}, 0
  while true do
    __i = __src:find("\\n", __i + 1, true)
    if not __i then break end
    __nl[#__nl + 1] = __i
  end
  for __k = #__nl, 1, -1 do
    local __prefix = __src:sub(1, __nl[__k])
    local __suffix = __src:sub(__nl[__k] + 1)
    if __suffix:match("%S") and load(__prefix, "=cell", "t") then
      -- "return " goes on the suffix's own line, so line numbers in any
      -- error still point at the line the user wrote.
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
  for __i = 2, __r.n do __parts[#__parts + 1] = tostring(__r[__i]) end
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
 * Ask the kernel what its own language looks like, so the highlighter
 * colours the build that is actually running.
 *
 * Reserved words cannot be probed by enumeration -- Lua exposes no list --
 * so a candidate superset is offered and each one is tested by trying to
 * use it as an identifier. 5.4.7 reserves exactly stock Lua's 22; a 5.5
 * build that adds `switch` answers with 23 and the editor follows without
 * anyone editing a table. Globals need no candidates: `_G` enumerates.
 */
export function languageInfoChunk(candidates, nonce) {
  const list = candidates.map((w) => `"${w}"`).join(', ');
  return `local __N = "${nonce}"
local __reserved = {}
for _, __w in ipairs({ ${list} }) do
  if not load("local " .. __w .. " = 1", "=probe", "t") then
    __reserved[#__reserved + 1] = __w
  end
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
