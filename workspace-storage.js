/**
 * Workspace persistence in IndexedDB.
 *
 * v2 stores meta + one record per file so typing can persist a single dirty
 * file without structuredClone-ing a multi‑MB thesis on the UI thread.
 */
(function (global) {
  "use strict";

  const DB_NAME = "undertwig-workspace-v1";
  const DB_VERSION = 2;
  const LEGACY_STORE = "workspace";
  const LEGACY_KEY = "current";
  const META_STORE = "meta";
  const FILES_STORE = "files";
  const META_KEY = "current";
  const FILE_CHUNK = 24;

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error("IndexedDB is not available in this browser."));
        return;
      }
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (event) {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE);
        }
        if (!db.objectStoreNames.contains(LEGACY_STORE)) {
          db.createObjectStore(LEGACY_STORE);
        }
        // Migration from v1 single-blob runs after open (needs read of legacy).
        request.transaction.oncomplete = function () {
          /* opened below */
        };
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

  function yieldToUi() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function cloneValue(value) {
    if (typeof global.structuredClone === "function") {
      try {
        return global.structuredClone(value);
      } catch (_error) {
        /* fall through */
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function cloneFileEntry(file) {
    if (!file || typeof file !== "object") {
      return { name: "file", content: "", binary: false };
    }
    return {
      name: file.name == null ? "file" : String(file.name),
      content: file.content == null ? "" : file.content,
      binary: Boolean(file.binary),
    };
  }

  function metaFromWorkspace(workspace) {
    return {
      version: (workspace && workspace.version) || 2,
      currentProject: String((workspace && workspace.currentProject) || ""),
      activeFile: String((workspace && workspace.activeFile) || ""),
      folders: Array.isArray(workspace && workspace.folders)
        ? workspace.folders.slice()
        : [],
    };
  }

  async function migrateLegacyIfNeeded(db) {
    if (!db.objectStoreNames.contains(LEGACY_STORE)) {
      return null;
    }
    const tx = db.transaction(
      [LEGACY_STORE, META_STORE, FILES_STORE],
      "readwrite"
    );
    const legacy = await idbRequest(tx.objectStore(LEGACY_STORE).get(LEGACY_KEY));
    if (!legacy || typeof legacy !== "object" || !legacy.files) {
      await waitForTransaction(tx);
      return null;
    }
    const metaStore = tx.objectStore(META_STORE);
    const filesStore = tx.objectStore(FILES_STORE);
    metaStore.put(metaFromWorkspace(legacy), META_KEY);
    const paths = Object.keys(legacy.files);
    for (let i = 0; i < paths.length; i += 1) {
      filesStore.put(cloneFileEntry(legacy.files[paths[i]]), paths[i]);
    }
    tx.objectStore(LEGACY_STORE).delete(LEGACY_KEY);
    await waitForTransaction(tx);
    return true;
  }

  async function saveMeta(meta) {
    const snapshot = cloneValue(metaFromWorkspace(meta));
    const db = await openDb();
    try {
      await migrateLegacyIfNeeded(db);
      const tx = db.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put(snapshot, META_KEY);
      await waitForTransaction(tx);
    } finally {
      db.close();
    }
  }

  /**
   * Persist only the given path→file map (one structured clone per file).
   */
  async function saveFiles(fileMap) {
    const paths = Object.keys(fileMap || {});
    if (!paths.length) {
      return { written: 0 };
    }
    let written = 0;
    for (let i = 0; i < paths.length; i += FILE_CHUNK) {
      const slice = paths.slice(i, i + FILE_CHUNK);
      const db = await openDb();
      try {
        const tx = db.transaction(FILES_STORE, "readwrite");
        const store = tx.objectStore(FILES_STORE);
        for (let j = 0; j < slice.length; j += 1) {
          const path = slice[j];
          store.put(cloneFileEntry(fileMap[path]), path);
          written += 1;
        }
        await waitForTransaction(tx);
      } finally {
        db.close();
      }
      if (i + FILE_CHUNK < paths.length) {
        await yieldToUi();
      }
    }
    return { written: written };
  }

  async function deleteFiles(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) {
      return { deleted: 0 };
    }
    let deleted = 0;
    for (let i = 0; i < list.length; i += FILE_CHUNK) {
      const slice = list.slice(i, i + FILE_CHUNK);
      const db = await openDb();
      try {
        const tx = db.transaction(FILES_STORE, "readwrite");
        const store = tx.objectStore(FILES_STORE);
        for (let j = 0; j < slice.length; j += 1) {
          store.delete(slice[j]);
          deleted += 1;
        }
        await waitForTransaction(tx);
      } finally {
        db.close();
      }
      if (i + FILE_CHUNK < list.length) {
        await yieldToUi();
      }
    }
    return { deleted: deleted };
  }

  /**
   * Replace the whole workspace in chunks (import / explicit Save).
   * Avoids one giant structuredClone of the entire tree.
   */
  async function replaceAll(workspace, options) {
    if (!workspace || typeof workspace !== "object") {
      throw new Error("Nothing to save.");
    }
    const onProgress =
      options && typeof options.onProgress === "function"
        ? options.onProgress
        : null;
    const meta = metaFromWorkspace(workspace);
    const files = (workspace && workspace.files) || {};
    const paths = Object.keys(files);

    const db = await openDb();
    try {
      await migrateLegacyIfNeeded(db);
      // Clear files store, write meta.
      const clearTx = db.transaction([META_STORE, FILES_STORE], "readwrite");
      clearTx.objectStore(META_STORE).put(cloneValue(meta), META_KEY);
      clearTx.objectStore(FILES_STORE).clear();
      await waitForTransaction(clearTx);
    } finally {
      db.close();
    }

    let written = 0;
    for (let i = 0; i < paths.length; i += FILE_CHUNK) {
      const slice = paths.slice(i, i + FILE_CHUNK);
      const batch = {};
      for (let j = 0; j < slice.length; j += 1) {
        batch[slice[j]] = files[slice[j]];
      }
      const result = await saveFiles(batch);
      written += result.written;
      if (onProgress) {
        onProgress(written, paths.length);
      }
      await yieldToUi();
    }
    return { written: written };
  }

  /** @deprecated Use replaceAll / saveFiles. Kept for older call sites. */
  async function save(workspace) {
    return replaceAll(workspace);
  }

  async function load() {
    const db = await openDb();
    try {
      await migrateLegacyIfNeeded(db);

      let meta = null;
      if (db.objectStoreNames.contains(META_STORE)) {
        const metaTx = db.transaction(META_STORE, "readonly");
        meta = await idbRequest(metaTx.objectStore(META_STORE).get(META_KEY));
        await waitForTransaction(metaTx);
      }

      const files = {};
      if (db.objectStoreNames.contains(FILES_STORE)) {
        const filesTx = db.transaction(FILES_STORE, "readonly");
        const store = filesTx.objectStore(FILES_STORE);
        // Issue both requests before awaiting so the transaction stays active.
        const keysReq = store.getAllKeys();
        const valuesReq = store.getAll();
        const allKeys = await idbRequest(keysReq);
        const allValues = await idbRequest(valuesReq);
        await waitForTransaction(filesTx);
        for (let i = 0; i < allKeys.length; i += 1) {
          files[allKeys[i]] = allValues[i];
        }
      }

      const fileCount = Object.keys(files).length;
      if (meta && typeof meta === "object" && fileCount > 0) {
        return {
          version: meta.version || 2,
          currentProject: meta.currentProject || "",
          activeFile: meta.activeFile || "",
          folders: Array.isArray(meta.folders) ? meta.folders : [],
          files: files,
        };
      }

      // Fallback: legacy single blob still present.
      if (db.objectStoreNames.contains(LEGACY_STORE)) {
        const legacyTx = db.transaction(LEGACY_STORE, "readonly");
        const legacy = await idbRequest(
          legacyTx.objectStore(LEGACY_STORE).get(LEGACY_KEY)
        );
        await waitForTransaction(legacyTx);
        if (legacy && typeof legacy === "object" && legacy.files) {
          return legacy;
        }
      }
      return null;
    } finally {
      db.close();
    }
  }

  async function clear() {
    const db = await openDb();
    try {
      const names = [];
      if (db.objectStoreNames.contains(META_STORE)) names.push(META_STORE);
      if (db.objectStoreNames.contains(FILES_STORE)) names.push(FILES_STORE);
      if (db.objectStoreNames.contains(LEGACY_STORE)) names.push(LEGACY_STORE);
      if (!names.length) return;
      const tx = db.transaction(names, "readwrite");
      names.forEach(function (name) {
        tx.objectStore(name).clear();
      });
      await waitForTransaction(tx);
    } finally {
      db.close();
    }
  }

  global.UndertwigWorkspaceStorage = {
    save: save,
    replaceAll: replaceAll,
    saveMeta: saveMeta,
    saveFiles: saveFiles,
    deleteFiles: deleteFiles,
    load: load,
    clear: clear,
    cloneWorkspace: cloneValue,
  };
})(typeof window !== "undefined" ? window : globalThis);
