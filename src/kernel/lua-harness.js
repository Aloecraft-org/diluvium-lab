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
  // The one record kind that is not terminal. A cell emits any number of
  // these, at any point, interleaved with its own output -- which is why
  // stdout is parsed as a *sequence* of records rather than as "user text,
  // then one record at the end". See parseRecords.
  DISPLAY: 'D',
};

/**
 * Mime types the Lab renders itself, from data rather than from markup.
 *
 * Vendor types rather than `text/html`, deliberately. A notebook is
 * untrusted input -- it arrives from files and from other people's
 * repositories -- and a chart described as `{"series": [...]}` cannot
 * carry a script tag, an event handler or a remote URL, whatever the file
 * says. The Lab draws it, so it is also themed, responsive and consistent
 * with the rest of the page for free.
 *
 * The `+json` suffix is RFC 6839's, so a tool that does not know these
 * types still knows they are JSON. Anything that cannot render them falls
 * back to the `text/plain` that always ships beside them.
 */
export const MIME = {
  PLOT: 'application/vnd.diluvium.plot+json',
  EVENTS: 'application/vnd.diluvium.events+json',
  WIDGET: 'application/vnd.diluvium.widget+json',
};

/**
 * Where the kernel keeps state that must outlive a cell.
 *
 * In `debug.getregistry()`, which is what the Lua registry is for, so a
 * program's `_G` stays the program's. `languageInfoChunk` filters this key
 * out of the globals list for the case where `debug` is unavailable and
 * `_G` is the fallback.
 */
export const REGISTRY_KEY = 'diluvium.lab';

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

/**
 * The display channel: how a program says something that is not text.
 *
 * Everything the Lab draws -- plots, images, event streams, controls --
 * arrives through one primitive, `display`, which takes a **mime bundle**
 * exactly as Jupyter's `display_data` does. That is not decoration: the
 * bundle is what nbformat stores, so a plot survives a save, opens in
 * JupyterLab, and renders on GitHub through its `text/plain` fallback.
 * Adding a second, private channel would have bought nothing and cost the
 * round trip.
 *
 * Three decisions worth stating, because each had a plausible alternative:
 *
 * 1. **Lua emits data; the Lab draws.** `plot` sends numbers and labels,
 *    not SVG. A chart built in Lua would have to know the page's theme,
 *    its fonts and its width, and none of those are knowable from inside
 *    the kernel -- so it would be wrong in dark mode, wrong on a phone,
 *    and stale the moment either changed. It also means the built-in
 *    types carry no markup at all, so there is no injection surface to
 *    get wrong. `display` still accepts `image/png` and `image/svg+xml`
 *    for programs that genuinely have a picture; those go through the
 *    sanitiser on the way in.
 * 2. **State lives in the registry, not in `_G`.** The nonce and the
 *    widget table have to survive between cells, and a notebook whose
 *    `_G` is littered with the tool's own bookkeeping is a notebook where
 *    `for k in pairs(_G)` lies to you. `debug.getregistry()` is the
 *    standard place for exactly this. `_G` is the fallback for a build
 *    with `debug` narrowed away, and `languageInfoChunk` filters the key
 *    back out of the completion list.
 * 3. **The API never clobbers a name the program owns.** Each global is
 *    installed only if the slot is empty or still holds the function we
 *    put there last time. A program with its own `plot` keeps it.
 */
const DISPLAY_LUA = `
local __reg = (type(debug) == "table" and type(debug.getregistry) == "function")
  and debug.getregistry() or _G
local __S = __reg["${REGISTRY_KEY}"]
if type(__S) ~= "table" then
  __S = { widgets = {}, owned = {}, seq = 0 }
  __reg["${REGISTRY_KEY}"] = __S
end
-- The nonce changes every request, and the API functions outlive the
-- chunk that defined them, so they must read it rather than close over it.
-- A stale nonce would frame a display record nobody is listening for.
__S.nonce = __N

-- JSON, because the structured mime types are JSON and Lua has no encoder.
-- Small on purpose: this exists to serialise plot specs and event records,
-- not to be a library.
local __JESC = {}
local function __jstr(__s)
  return '"' .. (__s:gsub('[%c"\\\\]', function(__c)
    local __e = __JESC[__c]
    if not __e then
      __e = string.format("\\\\u%04x", __c:byte())
      __JESC[__c] = __e
    end
    return __e
  end)) .. '"'
end
__JESC['"'] = '\\\\"'
__JESC["\\\\"] = "\\\\\\\\"
__JESC["\\n"] = "\\\\n"
__JESC["\\r"] = "\\\\r"
__JESC["\\t"] = "\\\\t"
-- A table is an array when its keys are exactly 1..#t. An empty table is
-- an array, which is the usual Lua reading and the one the plot and event
-- shapes want -- an empty series is [] rather than {}.
local function __jarray(__v)
  local __n = 0
  for __k in pairs(__v) do
    if type(__k) ~= "number" or __k % 1 ~= 0 or __k < 1 then return false end
    if __k > __n then __n = __k end
  end
  return __n == #__v
end
local function __json(__v, __depth)
  local __t = type(__v)
  if __v == nil then return "null" end
  if __t == "boolean" then return tostring(__v) end
  if __t == "number" then
    -- JSON has no NaN and no infinities. Writing them anyway produces a
    -- document that parses nowhere, so a gap in a line is a null -- which
    -- is also exactly how the chart renderer reads a missing point.
    if __v ~= __v or __v == math.huge or __v == -math.huge then return "null" end
    if math.type and math.type(__v) == "integer" then return string.format("%d", __v) end
    return (string.format("%.17g", __v))
  end
  if __t == "string" then return __jstr(__v) end
  if __t ~= "table" then return __jstr(tostring(__v)) end
  if (__depth or 0) > 12 then return "null" end
  local __out = {}
  if __jarray(__v) then
    for __i = 1, #__v do __out[__i] = __json(__v[__i], (__depth or 0) + 1) end
    return "[" .. table.concat(__out, ",") .. "]"
  end
  local __keys = {}
  for __k in pairs(__v) do
    if type(__k) == "string" then __keys[#__keys + 1] = __k end
  end
  table.sort(__keys)
  for __i = 1, #__keys do
    __out[__i] = __jstr(__keys[__i]) .. ":" .. __json(__v[__keys[__i]], (__depth or 0) + 1)
  end
  return "{" .. table.concat(__out, ",") .. "}"
end

-- One display record: mime SEP bytelen SEP data, repeated. Length-prefixed
-- for the same reason the outer record is -- an SVG or a JSON string can
-- contain anything at all, separator included.
local function __emit(__bundle)
  local __parts = {}
  for __i = 1, #__bundle do
    local __mime = __bundle[__i][1]
    local __data = tostring(__bundle[__i][2])
    __parts[#__parts + 1] = __mime .. "\\1" .. tostring(#__data) .. "\\1" .. __data
  end
  local __payload = table.concat(__parts)
  io.write(__S.nonce, "\\1", "${RECORD.DISPLAY}", "\\1", tostring(#__payload), "\\1", __payload)
end

local function __display(__t)
  if type(__t) ~= "table" then
    error("display expects a table of mime type -> data, e.g. display{ ['text/plain'] = 'hi' }", 2)
  end
  local __bundle = {}
  for __mime, __data in pairs(__t) do
    if type(__mime) == "string" then __bundle[#__bundle + 1] = { __mime, __data } end
  end
  if #__bundle == 0 then error("display was given an empty bundle", 2) end
  table.sort(__bundle, function(__a, __b) return __a[1] < __b[1] end)
  __emit(__bundle)
end

local function __structured(__mime, __spec, __fallback)
  __emit({ { "text/plain", __fallback }, { __mime, __json(__spec, 0) } })
end

-- \`plot\` is callable for the full spec and carries the shorthands as
-- fields, so \`plot.line{1,4,9}\` and \`plot{ series = {...} }\` are the same
-- mechanism rather than two.
local function __toxy(__a, __b)
  if __b == nil then
    local __x, __y = {}, {}
    for __i = 1, #__a do __x[__i] = __i; __y[__i] = __a[__i] end
    return __x, __y
  end
  return __a, __b
end

local function __plotspec(__spec)
  if type(__spec) ~= "table" then error("plot expects a table", 2) end
  local __series = __spec.series
  if type(__series) ~= "table" or #__series == 0 then
    error("plot needs a series list: plot{ series = { { y = {1,2,3} } } }", 2)
  end
  local __n = 0
  for __i = 1, #__series do
    local __s = __series[__i]
    if type(__s) ~= "table" or type(__s.y) ~= "table" then
      error("every series needs a \`y\` list of numbers", 2)
    end
    if __s.x == nil then
      local __x = {}
      for __j = 1, #__s.y do __x[__j] = __j end
      __s.x = __x
    end
    __s.kind = __s.kind or __spec.kind or "line"
    __n = __n + #__s.y
  end
  local __what = #__series == 1 and (__series[1].name or __series[1].kind)
    or (#__series .. " series")
  __structured("${MIME.PLOT}", __spec,
    "[plot: " .. __what .. ", " .. __n .. " points" ..
    (__spec.title and (" -- " .. tostring(__spec.title)) or "") .. "]")
end

local __plot = setmetatable({
  line = function(__a, __b, __opts)
    local __x, __y = __toxy(__a, __b)
    local __s = __opts or {}
    __s.series = { { kind = "line", x = __x, y = __y, name = __s.name } }
    __s.name = nil
    __plotspec(__s)
  end,
  scatter = function(__a, __b, __opts)
    local __x, __y = __toxy(__a, __b)
    local __s = __opts or {}
    __s.series = { { kind = "scatter", x = __x, y = __y, name = __s.name } }
    __s.name = nil
    __plotspec(__s)
  end,
  bar = function(__labels, __values, __opts)
    local __s = __opts or {}
    if __values == nil then __values, __labels = __labels, nil end
    local __x = {}
    for __i = 1, #__values do __x[__i] = __i end
    __s.labels = __s.labels or __labels
    __s.series = { { kind = "bar", x = __x, y = __values, name = __s.name } }
    __s.name = nil
    __plotspec(__s)
  end,
}, { __call = function(_, __spec) __plotspec(__spec) end })

-- The event stream. The record shape is doc/Messaging.md 9.2's exactly --
-- \`event\`, \`id\`, \`detail\` -- so the day a kernel can drain a real
-- \`system/events\` queue, the producer changes and this renderer does not.
local function __events(__list, __opts)
  if type(__list) ~= "table" then error("events expects a list of records", 2) end
  local __spec = __opts or {}
  __spec.events = __list
  __structured("${MIME.EVENTS}", __spec, "[events: " .. #__list .. " records]")
end

-- Controls. The callback is kept in Lua, keyed by id, and the page asks
-- for it by id when the control moves -- so the closure and everything it
-- captured stay in the kernel, which is the only place they can live.
--
-- Nothing is returned, deliberately. A cell ending in \`widget.slider{...}\`
-- is the ordinary way to write one, and returning the id would make that
-- cell echo \`Out[3]: w1\` under the control every single time -- a piece of
-- our own bookkeeping presented as the user's result.
local function __control(__kind, __opts)
  if type(__opts) ~= "table" then error(__kind .. " expects a table of options", 2) end
  __S.seq = __S.seq + 1
  local __id = "w" .. __S.seq
  if type(__opts.on_change) == "function" then
    __S.widgets[__id] = __opts.on_change
  end
  local __spec = {
    id = __id, kind = __kind, label = __opts.label or __opts.name,
    value = __opts.value, min = __opts.min, max = __opts.max, step = __opts.step,
    options = __opts.options, text = __opts.text,
  }
  __structured("${MIME.WIDGET}", __spec,
    "[" .. __kind .. (__spec.label and (": " .. tostring(__spec.label)) or "") .. "]")
end

local __widget = {
  slider = function(__o) return __control("slider", __o) end,
  select = function(__o) return __control("select", __o) end,
  checkbox = function(__o) return __control("checkbox", __o) end,
  button = function(__o) return __control("button", __o) end,
}

-- Install, without ever taking a name the program has claimed. A slot is
-- ours to write if it is empty or still holds what we last put in it --
-- which is remembered by name, so this is four entries forever rather than
-- four more per cell run.
local function __install(__name, __value)
  local __have = rawget(_G, __name)
  if __have == nil or __have == __S.owned[__name] then
    __S.owned[__name] = __value
    rawset(_G, __name, __value)
  end
end
__install("display", __display)
__install("plot", __plot)
__install("events", __events)
__install("widget", __widget)
`;

export function executeChunk(code, nonce) {
  return `local __N = "${nonce}"
local __src = ${luaLongString(code)}
${RENDER_LUA}
${DISPLAY_LUA}

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
 * Run the callback a control was registered with, against its new value.
 *
 * The closure never leaves the kernel -- it cannot; it captured locals that
 * exist nowhere else -- so the page holds an id and asks for the function
 * by name. Everything else is the ordinary execute path: the callback may
 * print, may `display`, may fail, and each reports through the same
 * records, so a control that draws a chart needs nothing new at all.
 *
 * A dead id is not an error. It is what a reloaded notebook looks like:
 * the controls were restored from the file, the kernel that held their
 * callbacks was not.
 *
 * @param {string} id the control's id
 * @param {string} valueLiteral the new value, already a Lua literal
 */
export function widgetChunk(id, valueLiteral, nonce) {
  return `local __N = "${nonce}"
${RENDER_LUA}
${DISPLAY_LUA}
-- The spaces inside the brackets are load-bearing. \`t[[[x]]]\` puts a long
-- string's opening \`[[\` directly against the index's \`[\`, and Lua lexes the
-- run greedily: it fails with "unexpected symbol near ']'", which points
-- at the wrong end of the expression and explains nothing.
local __fn = __S.widgets[ ${luaLongString(id)} ]
if type(__fn) ~= "function" then
  local __s = "stale"
  ${emit(RECORD.OK, '__s')}
  return
end
local __r = table.pack(xpcall(__fn, function(__err)
  return tostring(__err) .. "\\1" .. debug.traceback("", 2)
end, ${valueLiteral}))
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
 * A JS value as a Lua literal, for the small set a control can produce.
 *
 * Deliberately not general: numbers, booleans and strings are what a
 * slider, a checkbox and a select can hand back, and anything else is a
 * bug in the caller rather than a value to guess at.
 */
export function luaLiteral(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return luaLongString(String(value ?? ''));
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
${DISPLAY_LUA}
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
  -- The registry is the normal home for the Lab's own state; _G is the
  -- fallback where the debug library is unavailable, and in that case the
  -- key would otherwise show up as a completion candidate nobody can use.
  if type(__k) == "string" and __k ~= "${REGISTRY_KEY}" then
    __globals[#__globals + 1] = __k
  end
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
  const { output, records } = parseRecords(stdout, nonce);
  return { output, record: records.length ? records[records.length - 1] : null };
}

/**
 * Split raw stdout into the pieces it is made of, **in order**.
 *
 * Until displays existed, a request produced at most one record and it was
 * always last, so "everything before the nonce" was the user's output.
 * That stops being true the moment a cell can emit a chart halfway
 * through: `print("before") plot.line{1,2} print("after")` has to arrive
 * as three things in that order, not as two lines of text with a picture
 * bolted on the end.
 *
 * So stdout is a sequence: text, record, text, record, ... Each record is
 * `nonce SEP kind SEP length SEP payload`, and the length is what makes a
 * payload able to contain anything, separators and nonces included.
 *
 * A record that does not parse ends the scan and the remainder is treated
 * as output. That is the truncation case -- the kernel stopped recording
 * mid-record -- and inventing a record out of half of one would be worse
 * than showing the bytes.
 *
 * @returns {{ output: string, records: Array<{kind: string, payload: string}>,
 *             pieces: Array<{type: 'output'|'record', text?: string, kind?: string, payload?: string}> }}
 *   `output` is every text piece concatenated, which is what callers that
 *   do not care about interleaving want.
 */
export function parseRecords(stdout, nonce) {
  const pieces = [];
  const records = [];
  let at = 0;
  let cut = false;

  for (;;) {
    const found = stdout.indexOf(nonce, at);
    if (found === -1) break;

    const rest = stdout.slice(found + nonce.length);
    // A record that does not parse is one the output cap cut short --
    // nothing else can produce a nonce followed by a broken frame. Report
    // it as such and drop the fragment: leaving it in `output` put the
    // raw nonce and separator bytes on the page, which is gibberish over
    // the top of whatever the cell had legitimately printed.
    const short = (n) => { cut = true; at = found; return n; };
    if (!rest.startsWith(SEP)) { short(); break; }
    const kindEnd = rest.indexOf(SEP, 1);
    if (kindEnd === -1) { short(); break; }
    const lenEnd = rest.indexOf(SEP, kindEnd + 1);
    if (lenEnd === -1) { short(); break; }
    const length = Number.parseInt(rest.slice(kindEnd + 1, lenEnd), 10);
    if (!Number.isInteger(length) || length < 0) { short(); break; }
    if (rest.length < lenEnd + 1 + length) { short(); break; }

    if (found > at) pieces.push({ type: 'output', text: stdout.slice(at, found) });
    const record = { kind: rest.slice(1, kindEnd), payload: rest.slice(lenEnd + 1, lenEnd + 1 + length) };
    records.push(record);
    pieces.push({ type: 'record', ...record });
    at = found + nonce.length + lenEnd + 1 + length;
  }

  // Everything from a cut record onward is a fragment of framing, not
  // output, so it is dropped rather than shown.
  if (!cut && at < stdout.length) pieces.push({ type: 'output', text: stdout.slice(at) });
  const output = pieces.filter((p) => p.type === 'output').map((p) => p.text).join('');
  return { output, records, pieces, cut };
}

/**
 * A display record's payload: `mime SEP bytelen SEP data`, repeated.
 *
 * Returns the mime bundle in nbformat's own shape -- a plain object from
 * mime type to string -- because that is what `display_data.data` is and
 * what gets written to the file.
 */
export function parseBundle(payload) {
  const bundle = {};
  let at = 0;
  while (at < payload.length) {
    const mimeEnd = payload.indexOf(SEP, at);
    if (mimeEnd === -1) break;
    const lenEnd = payload.indexOf(SEP, mimeEnd + 1);
    if (lenEnd === -1) break;
    const length = Number.parseInt(payload.slice(mimeEnd + 1, lenEnd), 10);
    if (!Number.isInteger(length) || length < 0) break;
    bundle[payload.slice(at, mimeEnd)] = payload.slice(lenEnd + 1, lenEnd + 1 + length);
    at = lenEnd + 1 + length;
  }
  return bundle;
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
