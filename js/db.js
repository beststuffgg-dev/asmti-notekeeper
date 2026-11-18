// Tiny IndexedDB wrapper. Images are stored as Blobs, so pages can hold large
// pictures without hitting the ~5 MB localStorage limit the original TINotes had.
(function (global) {
    'use strict';

    const DB_NAME = 'notekeeper';
    const VERSION = 1;
    let dbPromise;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!global.indexedDB) {
                reject(new Error('IndexedDB is not available in this browser.'));
                return;
            }
            const req = indexedDB.open(DB_NAME, VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                db.createObjectStore('notebooks', { keyPath: 'id' });
                const nodes = db.createObjectStore('nodes', { keyPath: 'id' });
                nodes.createIndex('notebookId', 'notebookId');
                db.createObjectStore('images', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    // Run `fn(store)` in one transaction; resolve with the request result once committed.
    function op(storeName, mode, fn) {
        return open().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const result = fn(tx.objectStore(storeName));
            tx.oncomplete = () => resolve(result && result.result);
            tx.onerror = tx.onabort = () => reject(tx.error);
        }));
    }

    global.DB = {
        get: (store, key) => op(store, 'readonly', (o) => o.get(key)),
        getAll: (store) => op(store, 'readonly', (o) => o.getAll()),
        nodesOf: (notebookId) => op('nodes', 'readonly', (o) => o.index('notebookId').getAll(notebookId)),
        put: (store, value) => op(store, 'readwrite', (o) => o.put(value)),
        putMany: (store, values) => op(store, 'readwrite', (o) => {
            let last;
            values.forEach((v) => { last = o.put(v); });
            return last;
        }),
        del: (store, key) => op(store, 'readwrite', (o) => o.delete(key)),
        delMany: (store, keys) => op(store, 'readwrite', (o) => {
            let last;
            keys.forEach((k) => { last = o.delete(k); });
            return last;
        }),
    };
})(window);
