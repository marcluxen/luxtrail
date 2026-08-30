const DB_NAME = 'luxtrail';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trips')) {
        db.createObjectStore('trips', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId');
      }
      if (!db.objectStoreNames.contains('waypoints')) {
        const s = db.createObjectStore('waypoints', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId');
      }
      if (!db.objectStoreNames.contains('pois')) {
        const s = db.createObjectStore('pois', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId');
      }
      if (!db.objectStoreNames.contains('tileSources')) {
        db.createObjectStore('tileSources', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('mapDownloads')) {
        db.createObjectStore('mapDownloads', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const db = {
  async put(store, obj) {
    await tx(store, 'readwrite', (s) => s.put(obj));
    return obj;
  },
  async get(store, id) {
    const db2 = await openDb();
    const t = db2.transaction(store, 'readonly');
    return reqToPromise(t.objectStore(store).get(id));
  },
  async delete(store, id) {
    await tx(store, 'readwrite', (s) => s.delete(id));
  },
  async all(store) {
    const db2 = await openDb();
    const t = db2.transaction(store, 'readonly');
    return reqToPromise(t.objectStore(store).getAll());
  },
  async byIndex(store, indexName, value) {
    const db2 = await openDb();
    const t = db2.transaction(store, 'readonly');
    return reqToPromise(t.objectStore(store).index(indexName).getAll(value));
  },
  async setSetting(key, value) {
    await tx('settings', 'readwrite', (s) => s.put({ key, value }));
  },
  async getSetting(key, fallback) {
    const row = await this.get('settings', key);
    return row ? row.value : fallback;
  },
};
