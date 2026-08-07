// Autosave, in IndexedDB.
//
// IndexedDB and not localStorage, which is a decision rather than a
// preference: localStorage's ~5 MB is a single notebook with a few hundred
// lines of saved output, and it fails by throwing on write rather than by
// telling you anything useful.

const DB_NAME = 'diluvium-lab';
const DB_VERSION = 2;
const STORE = 'notebooks';
/**
 * Downloaded runtimes, so switching versions costs a megabyte once rather
 * than once per reload. IndexedDB and not the Cache API: the Cache API is
 * also secure-context-only, and one store is one thing to clear.
 */
const RUNTIME_STORE = 'runtimes';
const AUTOSAVE_KEY = 'autosave';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(RUNTIME_STORE)) db.createObjectStore(RUNTIME_STORE);
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

export function putRuntime(key, record) {
  return withDb((db) => transact(db, RUNTIME_STORE, 'readwrite', (s) => s.put(record, key)));
}

export async function getRuntime(key) {
  return (await withDb((db) => transact(db, RUNTIME_STORE, 'readonly', (s) => s.get(key)))) ?? null;
}

export async function listRuntimeKeys() {
  return (await withDb((db) => transact(db, RUNTIME_STORE, 'readonly', (s) => s.getAllKeys()))) ?? [];
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
