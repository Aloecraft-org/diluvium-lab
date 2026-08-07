// Autosave, in IndexedDB.
//
// IndexedDB and not localStorage, which is a decision rather than a
// preference: localStorage's ~5 MB is a single notebook with a few hundred
// lines of saved output, and it fails by throwing on write rather than by
// telling you anything useful.

const DB_NAME = 'diluvium-lab';
const DB_VERSION = 1;
const STORE = 'notebooks';
const AUTOSAVE_KEY = 'autosave';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveAutosave(record) {
  const db = await open();
  try {
    await transact(db, 'readwrite', (store) => store.put(record, AUTOSAVE_KEY));
  } finally {
    db.close();
  }
}

export async function loadAutosave() {
  const db = await open();
  try {
    return (await transact(db, 'readonly', (store) => store.get(AUTOSAVE_KEY))) ?? null;
  } finally {
    db.close();
  }
}

export async function clearAutosave() {
  const db = await open();
  try {
    await transact(db, 'readwrite', (store) => store.delete(AUTOSAVE_KEY));
  } finally {
    db.close();
  }
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
