/**
 * Full workspace persistence in IndexedDB.
 * localStorage (~5MB) cannot hold large LaTeX projects; IDB typically allows
 * hundreds of MB+, which is what Import / Save need offline.
 */
(function (global) {
  "use strict";

  const DB_NAME = "undertwig-workspace-v1";
  const DB_VERSION = 1;
  const STORE = "workspace";
  const KEY = "current";

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error("IndexedDB is not available in this browser."));
        return;
      }
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB open failed"));
      };
    });
  }

  function idbRequest(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB request failed"));
      };
    });
  }

  function waitForTransaction(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error || new Error("IndexedDB transaction failed"));
      };
      tx.onabort = function () {
        reject(tx.error || new Error("IndexedDB transaction aborted"));
      };
    });
  }

  /**
   * Structured-clone a plain workspace snapshot so callers can keep mutating
   * their live state object while the write completes.
   */
  function cloneWorkspace(workspace) {
    if (typeof global.structuredClone === "function") {
      try {
        return global.structuredClone(workspace);
      } catch (_error) {
        // Fall through to JSON clone.
      }
    }
    return JSON.parse(JSON.stringify(workspace));
  }

  async function save(workspace) {
    if (!workspace || typeof workspace !== "object") {
      throw new Error("Nothing to save.");
    }
    const snapshot = cloneWorkspace(workspace);
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snapshot, KEY);
      await waitForTransaction(tx);
    } finally {
      db.close();
    }
  }

  async function load() {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      const value = await idbRequest(tx.objectStore(STORE).get(KEY));
      await waitForTransaction(tx);
      return value && typeof value === "object" ? value : null;
    } finally {
      db.close();
    }
  }

  async function clear() {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      await waitForTransaction(tx);
    } finally {
      db.close();
    }
  }

  global.UndertwigWorkspaceStorage = {
    save: save,
    load: load,
    clear: clear,
    cloneWorkspace: cloneWorkspace,
  };
})(typeof window !== "undefined" ? window : globalThis);
