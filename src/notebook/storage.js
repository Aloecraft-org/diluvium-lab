// Autosave, in IndexedDB.
//
// IndexedDB and not localStorage, which is a decision rather than a
// preference: localStorage's ~5 MB is a single notebook with a few hundred
// lines of saved output, and it fails by throwing on write rather than by
// telling you anything useful.

const DB_NAME = 'diluvium-lab';
const DB_VERSION = 3;
const STORE = 'notebooks';
/**
 * Downloaded runtimes, so switching versions costs a megabyte once rather
 * than once per reload. IndexedDB and not the Cache API: the Cache API is
 * also secure-context-only, and one store is one thing to clear.
 */
const RUNTIME_STORE = 'runtimes';
/**
 * Notebooks opened before, most recent first.
 *
 * The content is kept, not just the name. A recents list that only
 * remembers where something came from can reopen a URL and cannot reopen
 * a file -- the browser gives no way to re-read a local file without
 * asking again -- so half the entries would be decoration. Keeping the
 * bytes makes every entry work, and works offline.
 */
const RECENT_STORE = 'recent';
const AUTOSAVE_KEY = 'autosave';

/** How many to keep, and how large one may be before it is not worth it. */
export const MAX_RECENT = 12;
export const MAX_RECENT_BYTES = 2 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(RUNTIME_STORE)) db.createObjectStore(RUNTIME_STORE);
      if (!db.objectStoreNames.contains(RECENT_STORE)) {
        // Keyed by `openedAt` so a cursor walks them in time order and the
        // oldest is the first thing a trim reaches.
        db.createObjectStore(RECENT_STORE, { keyPath: 'openedAt' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function withDb(fn) {
  const db = await open();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export function saveAutosave(record) {
  return withDb((db) => transact(db, STORE, 'readwrite', (s) => s.put(record, AUTOSAVE_KEY)));
}

export async function loadAutosave() {
  return (await withDb((db) => transact(db, STORE, 'readonly', (s) => s.get(AUTOSAVE_KEY)))) ?? null;
}

export function clearAutosave() {
  return withDb((db) => transact(db, STORE, 'readwrite', (s) => s.delete(AUTOSAVE_KEY)));
}

/**
 * The tool panel's state -- which tool is open, or that none is. A second
 * key in the notebooks store rather than a store of its own: it is one
 * tiny record, and a new store means a DB version bump every reader pays
 * for.
 */
const PANEL_KEY = 'panel';

export function savePanelState(state) {
  return withDb((db) => transact(db, STORE, 'readwrite', (s) => s.put(state, PANEL_KEY)));
}

export async function loadPanelState() {
  return (await withDb((db) => transact(db, STORE, 'readonly', (s) => s.get(PANEL_KEY)))) ?? null;
}

/**
 * Small UI preferences -- the masthead collapsed, the first visit seen.
 * Same store, `pref:`-prefixed keys, same reasoning as the panel state:
 * one tiny record each is not worth a store and a version bump.
 */
export function savePref(key, value) {
  return withDb((db) => transact(db, STORE, 'readwrite', (s) => s.put(value, `pref:${key}`)));
}

export async function loadPref(key) {
  return (await withDb((db) => transact(db, STORE, 'readonly', (s) => s.get(`pref:${key}`)))) ?? null;
}

export function putRuntime(key, record) {
  return withDb((db) => transact(db, RUNTIME_STORE, 'readwrite', (s) => s.put(record, key)));
}

export async function getRuntime(key) {
  return (await withDb((db) => transact(db, RUNTIME_STORE, 'readonly', (s) => s.get(key)))) ?? null;
}

export async function listRuntimeKeys() {
  return (await withDb((db) => transact(db, RUNTIME_STORE, 'readonly', (s) => s.getAllKeys()))) ?? [];
}

/**
 * Remember a notebook that was just opened.
 *
 * Deduplicated on `source` -- the URL, or the filename -- so reopening the
 * same notebook moves it up the list rather than filling the list with
 * itself. Failure is swallowed by the caller: a recents list is a
 * convenience, and losing it must never be what stops a notebook opening.
 */
export async function rememberRecent(entry) {
  const json = JSON.stringify(entry.ipynb ?? null);
  const record = {
    openedAt: Date.now(),
    name: entry.name ?? 'notebook.ipynb',
    /** The notebook's own name, which is not its filename. */
    title: entry.title ?? null,
    origin: entry.origin ?? 'file',      // 'file' | 'url' | 'example'
    url: entry.url ?? null,
    source: entry.url ?? entry.name ?? 'notebook.ipynb',
    cells: Array.isArray(entry.ipynb?.cells) ? entry.ipynb.cells.length : 0,
    // Held as text rather than as a live object: structured clone of a
    // deeply nested notebook is slower than one JSON round trip, and this
    // runs on every open.
    ipynb: json.length <= MAX_RECENT_BYTES ? json : null,
    bytes: json.length,
  };

  return withDb(async (db) => {
    const existing = await transact(db, RECENT_STORE, 'readonly', (s2) => s2.getAll());
    const keep = (existing ?? [])
      .filter((r) => r.source !== record.source)
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, MAX_RECENT - 1);
    const wanted = new Set(keep.map((r) => r.openedAt));
    return transact(db, RECENT_STORE, 'readwrite', (s2) => {
      for (const r of existing ?? []) if (!wanted.has(r.openedAt)) s2.delete(r.openedAt);
      return s2.put(record);
    });
  });
}

/** The recents, newest first. */
export async function listRecent() {
  const all = await withDb((db) => transact(db, RECENT_STORE, 'readonly', (s2) => s2.getAll()));
  return (all ?? []).sort((a, b) => b.openedAt - a.openedAt);
}

export function clearRecent() {
  return withDb((db) => transact(db, RECENT_STORE, 'readwrite', (s2) => s2.clear()));
}

export function clearRuntimes() {
  return withDb((db) => transact(db, RUNTIME_STORE, 'readwrite', (s) => s.clear()));
}

/**
 * Coalesce a burst of edits into one write.
 *
 * Every keystroke fires a change; writing on each one would serialise the
 * whole notebook per character. `flush()` exists so a test (or a beforeunload
 * handler) can force the pending write to land instead of racing it.
 */
export function debounceSave(save, delayMs = 400) {
  let timer = null;
  let pending = null;
  let inFlight = Promise.resolve();

  const write = () => {
    timer = null;
    const record = pending;
    pending = null;
    if (record === null) return inFlight;
    inFlight = save(record).catch((err) => {
      console.warn('autosave failed', err);
    });
    return inFlight;
  };

  return {
    schedule(record) {
      pending = record;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(write, delayMs);
    },
    async flush() {
      if (timer !== null) { clearTimeout(timer); await write(); }
      await inFlight;
    },
  };
}
