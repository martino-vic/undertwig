/**
 * Local project folder binding via the File System Access API.
 * Offline desktop: Import links a folder; Save writes back through that handle.
 */
(function (global) {
  "use strict";

  const DB_NAME = "undertwig-local-fs-v1";
  const STORE = "dirHandles";
  const SKIP_DIR_NAMES = new Set([
    ".git",
    "node_modules",
    ".svn",
    ".hg",
    "__MACOSX",
  ]);

  function supportsDirectoryPicker() {
    return (
      typeof global.showDirectoryPicker === "function" &&
      typeof global.indexedDB !== "undefined"
    );
  }

  function supportsSaveFilePicker() {
    return typeof global.showSaveFilePicker === "function";
  }

  function canWriteLocalFiles() {
    return supportsDirectoryPicker() || supportsSaveFilePicker();
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, 1);
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

  async function putHandle(projectName, handle) {
    const key = String(projectName || "").trim();
    if (!key || !handle) return;
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      await idbRequest(tx.objectStore(STORE).put(handle, key));
    } finally {
      db.close();
    }
  }

  async function getHandle(projectName) {
    const key = String(projectName || "").trim();
    if (!key) return null;
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readonly");
      return (await idbRequest(tx.objectStore(STORE).get(key))) || null;
    } finally {
      db.close();
    }
  }

  async function deleteHandle(projectName) {
    const key = String(projectName || "").trim();
    if (!key) return;
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, "readwrite");
      await idbRequest(tx.objectStore(STORE).delete(key));
    } finally {
      db.close();
    }
  }

  async function ensureReadWritePermission(handle) {
    if (!handle) return false;
    const opts = { mode: "readwrite" };
    if (typeof handle.queryPermission === "function") {
      let state = await handle.queryPermission(opts);
      if (state === "granted") return true;
      if (typeof handle.requestPermission === "function") {
        state = await handle.requestPermission(opts);
        return state === "granted";
      }
      return false;
    }
    return true;
  }

  async function pickProjectDirectory() {
    if (!supportsDirectoryPicker()) {
      throw new Error("This browser cannot keep a local project folder open.");
    }
    return global.showDirectoryPicker({
      id: "undertwig-local-project",
      mode: "readwrite",
    });
  }

  async function collectFiles(dirHandle, basePath) {
    const out = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (!name || name === "." || name === "..") continue;
      const rel = basePath ? basePath + "/" + name : name;
      if (handle.kind === "directory") {
        if (SKIP_DIR_NAMES.has(name)) continue;
        const nested = await collectFiles(handle, rel);
        for (let i = 0; i < nested.length; i += 1) out.push(nested[i]);
      } else if (handle.kind === "file") {
        out.push({
          relativePath: rel,
          file: await handle.getFile(),
          name: name,
        });
      }
    }
    return out;
  }

  async function getDirectoryAtPath(rootHandle, parts, create) {
    let current = rootHandle;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (!part || part === "." || part === "..") {
        throw new Error("Invalid path segment");
      }
      current = await current.getDirectoryHandle(part, { create: Boolean(create) });
    }
    return current;
  }

  async function writeFileAtPath(rootHandle, relativePath, data) {
    const norm = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = norm.split("/").filter(Boolean);
    if (!parts.length) throw new Error("Empty path");
    const fileName = parts.pop();
    const dir = await getDirectoryAtPath(rootHandle, parts, true);
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  function filePayload(file, helpers) {
    if (!file) return "";
    if (file.binary) {
      return helpers.base64ToBytes(file.content || "");
    }
    return file.content == null ? "" : String(file.content);
  }

  function yieldToUi() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  async function saveProjectToDirectory(projectName, state, helpers) {
    const name = String(projectName || "").trim();
    if (!name) throw new Error("No current project.");
    const handle = await getHandle(name);
    if (!handle) return { saved: false, reason: "no-handle", written: 0 };
    const allowed = await ensureReadWritePermission(handle);
    if (!allowed) {
      throw new Error(
        "Permission to write the local project folder was denied. Re-import the project folder."
      );
    }

    const prefix = name + "/";
    const files = (state && state.files) || {};
    const paths = Object.keys(files).filter(function (path) {
      return path.startsWith(prefix);
    });

    const onProgress = helpers && typeof helpers.onProgress === "function"
      ? helpers.onProgress
      : null;
    const signal = helpers && helpers.signal;

    let written = 0;
    let planned = 0;
    for (let i = 0; i < paths.length; i += 1) {
      const rel = paths[i].slice(prefix.length);
      if (
        rel &&
        !rel.split("/").some(function (part) {
          return SKIP_DIR_NAMES.has(part);
        })
      ) {
        planned += 1;
      }
    }

    for (let i = 0; i < paths.length; i += 1) {
      if (signal && signal.aborted) {
        const err = new Error("Save cancelled.");
        err.name = "AbortError";
        throw err;
      }
      const path = paths[i];
      const file = files[path];
      if (!file) continue;
      const rel = path.slice(prefix.length);
      if (
        !rel ||
        rel.split("/").some(function (part) {
          return SKIP_DIR_NAMES.has(part);
        })
      ) {
        continue;
      }
      await writeFileAtPath(handle, rel, filePayload(file, helpers));
      written += 1;
      if (onProgress) {
        onProgress(written, planned);
      }
      // Keep the tab responsive on large projects.
      if (written % 8 === 0) {
        await yieldToUi();
      }
    }

    return {
      saved: true,
      reason: "ok",
      written: written,
      folderName: handle.name || name,
    };
  }

  async function saveFileToDirectory(projectName, filePath, file, helpers) {
    const name = String(projectName || "").trim();
    const path = String(filePath || "").trim();
    if (!name) throw new Error("No current project.");
    if (!path || !file) {
      return { saved: false, reason: "no-file", written: 0 };
    }
    const prefix = name + "/";
    if (!path.startsWith(prefix)) {
      throw new Error("File is not in the current project.");
    }
    const rel = path.slice(prefix.length);
    if (
      !rel ||
      rel.split("/").some(function (part) {
        return SKIP_DIR_NAMES.has(part);
      })
    ) {
      throw new Error("Cannot save that path to the local folder.");
    }

    const handle = await getHandle(name);
    if (!handle) return { saved: false, reason: "no-handle", written: 0 };
    const allowed = await ensureReadWritePermission(handle);
    if (!allowed) {
      throw new Error(
        "Permission to write the local project folder was denied. Re-import the project folder."
      );
    }

    await writeFileAtPath(handle, rel, filePayload(file, helpers));
    return {
      saved: true,
      reason: "ok",
      written: 1,
      folderName: handle.name || name,
      relativePath: rel,
    };
  }

  async function saveFileWithSavePicker(fileName, file, helpers) {
    if (!supportsSaveFilePicker()) {
      return { saved: false, reason: "unsupported", written: 0 };
    }
    const name = String(fileName || "untitled.txt").split("/").pop() || "untitled.txt";
    const handle = await global.showSaveFilePicker({
      suggestedName: name,
      excludeAcceptAllOption: false,
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(filePayload(file, helpers));
    } finally {
      await writable.close();
    }
    return {
      saved: true,
      reason: "save-picker",
      written: 1,
      folderName: "",
      relativePath: name,
    };
  }

  function downloadFile(fileName, file, helpers) {
    const name = String(fileName || "untitled.txt").split("/").pop() || "untitled.txt";
    const payload = filePayload(file, helpers);
    const blob =
      payload instanceof Uint8Array
        ? new Blob([payload])
        : new Blob([String(payload)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    }
    return {
      saved: true,
      reason: "download",
      written: 1,
      folderName: "",
      relativePath: name,
    };
  }

  async function hasBoundDirectory(projectName) {
    try {
      return Boolean(await getHandle(projectName));
    } catch (_error) {
      return false;
    }
  }

  async function renameProjectBinding(fromName, toName) {
    const from = String(fromName || "").trim();
    const to = String(toName || "").trim();
    if (!from || !to || from === to) return;
    const handle = await getHandle(from);
    if (!handle) return;
    await putHandle(to, handle);
    await deleteHandle(from);
  }

  async function removeProjectBinding(projectName) {
    await deleteHandle(projectName);
  }

  global.UndertwigLocalFs = {
    supportsDirectoryPicker: supportsDirectoryPicker,
    supportsSaveFilePicker: supportsSaveFilePicker,
    canWriteLocalFiles: canWriteLocalFiles,
    pickProjectDirectory: pickProjectDirectory,
    collectFiles: collectFiles,
    putHandle: putHandle,
    getHandle: getHandle,
    deleteHandle: deleteHandle,
    ensureReadWritePermission: ensureReadWritePermission,
    saveProjectToDirectory: saveProjectToDirectory,
    saveFileToDirectory: saveFileToDirectory,
    saveFileWithSavePicker: saveFileWithSavePicker,
    downloadFile: downloadFile,
    hasBoundDirectory: hasBoundDirectory,
    renameProjectBinding: renameProjectBinding,
    removeProjectBinding: removeProjectBinding,
    yieldToUi: yieldToUi,
  };
})(window);
