/**
 * Local project folder binding (desktop, logged-out).
 * Remembers directory handles + absolute paths for Save and Console.
 */
(function (global) {
  "use strict";

  const DB_NAME = "undertwig-local-fs-v1";
  const STORE = "dirHandles";
  const META_KEY = "undertwig-local-project-meta-v1";
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

  function readMetaMap() {
    try {
      const raw = localStorage.getItem(META_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writeMetaMap(map) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(map || {}));
    } catch (_error) {
      // Ignore quota / private mode.
    }
  }

  function getProjectMeta(projectName) {
    const key = String(projectName || "").trim();
    if (!key) return null;
    const entry = readMetaMap()[key];
    if (!entry || typeof entry !== "object") return null;
    return {
      absolutePath: typeof entry.absolutePath === "string" ? entry.absolutePath : "",
      folderName: typeof entry.folderName === "string" ? entry.folderName : "",
    };
  }

  function setProjectMeta(projectName, meta) {
    const key = String(projectName || "").trim();
    if (!key) return;
    const map = readMetaMap();
    const absolutePath = String((meta && meta.absolutePath) || "").trim();
    const folderName = String((meta && meta.folderName) || "").trim();
    if (!absolutePath && !folderName) {
      delete map[key];
    } else {
      map[key] = { absolutePath: absolutePath, folderName: folderName };
    }
    writeMetaMap(map);
  }

  function clearProjectMeta(projectName) {
    setProjectMeta(projectName, null);
  }

  function basenamePath(absolutePath) {
    const norm = String(absolutePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = norm.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
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

  async function saveProjectToDirectory(projectName, state, helpers) {
    const name = String(projectName || "").trim();
    if (!name) throw new Error("No current project.");
    const handle = await getHandle(name);
    if (!handle) return { saved: false, reason: "no-handle", written: 0 };
    const allowed = await ensureReadWritePermission(handle);
    if (!allowed) {
      throw new Error(
        "Permission to write the local project folder was denied. Re-link the folder."
      );
    }

    const prefix = name + "/";
    const files = (state && state.files) || {};
    const paths = Object.keys(files).filter(function (path) {
      return path === name || path.startsWith(prefix);
    });

    let written = 0;
    for (let i = 0; i < paths.length; i += 1) {
      const path = paths[i];
      if (path === name) continue;
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
      const data = file.binary
        ? helpers.base64ToBytes(file.content || "")
        : file.content == null
          ? ""
          : String(file.content);
      await writeFileAtPath(handle, rel, data);
      written += 1;
    }

    return {
      saved: true,
      reason: "ok",
      written: written,
      folderName: handle.name || name,
    };
  }

  async function hasBoundDirectory(projectName) {
    try {
      return Boolean(await getHandle(projectName));
    } catch (_error) {
      return false;
    }
  }

  /**
   * Check whether the memorized local folder still matches reality.
   * hostCheck: optional async (absolutePath) => { exists, baseName }
   */
  async function verifyLocalBinding(projectName, hostCheck) {
    const name = String(projectName || "").trim();
    const meta = getProjectMeta(name);
    if (!meta || (!meta.absolutePath && !meta.folderName)) {
      return { ok: true, warning: null, meta: meta };
    }

    const warnings = [];
    let handle = null;
    try {
      handle = await getHandle(name);
    } catch (_error) {
      handle = null;
    }

    if (handle) {
      try {
        const allowed = await ensureReadWritePermission(handle);
        if (!allowed) {
          warnings.push(
            "Undertwig lost access to the local folder for “" +
              name +
              "”. Re-link it to keep Save and Console working."
          );
        } else {
          // Probe the handle still resolves.
          let seen = false;
          for await (const _entry of handle.entries()) {
            seen = true;
            break;
          }
          void seen;
          if (meta.folderName && handle.name && handle.name !== meta.folderName) {
            warnings.push(
              "The local folder was renamed from “" +
                meta.folderName +
                "” to “" +
                handle.name +
                "”. Update the saved path if Console should open there."
            );
          }
        }
      } catch (error) {
        const errName = error && error.name ? error.name : "";
        if (errName === "NotFoundError") {
          warnings.push(
            "The local folder for “" +
              name +
              "” was moved or deleted. Re-link the folder and update its path."
          );
        } else {
          warnings.push(
            "Could not access the local folder for “" +
              name +
              "”. Re-link it if Save or Console fail."
          );
        }
      }
    } else if (meta.absolutePath || meta.folderName) {
      // Meta without handle — path-only binding (still useful for Console).
    }

    if (meta.absolutePath && typeof hostCheck === "function") {
      try {
        const info = await hostCheck(meta.absolutePath);
        if (info && info.reachable) {
          if (!info.exists) {
            warnings.push(
              "The saved path no longer exists:\n" +
                meta.absolutePath +
                "\nUpdate the local path for this Work desk project."
            );
          } else if (
            meta.folderName &&
            info.baseName &&
            info.baseName !== meta.folderName
          ) {
            warnings.push(
              "The folder at the saved path is now named “" +
                info.baseName +
                "” (was “" +
                meta.folderName +
                "”). Update the local path if this is unexpected."
            );
          } else if (
            handle &&
            handle.name &&
            info.baseName &&
            handle.name !== info.baseName
          ) {
            warnings.push(
              "The linked folder (“" +
                handle.name +
                "”) no longer matches the saved path (“" +
                info.baseName +
                "”). Update the local path."
            );
          }
        }
      } catch (_error) {
        // Host optional for warnings.
      }
    }

    const unique = [];
    for (let i = 0; i < warnings.length; i += 1) {
      if (unique.indexOf(warnings[i]) === -1) unique.push(warnings[i]);
    }

    return {
      ok: unique.length === 0,
      warning: unique.length ? unique.join("\n\n") : null,
      meta: meta,
      handleName: handle && handle.name ? handle.name : "",
    };
  }

  async function bindProject(projectName, handle, absolutePath) {
    const name = String(projectName || "").trim();
    if (!name) throw new Error("Missing project name");
    if (handle) {
      await putHandle(name, handle);
    }
    const folderName =
      (handle && handle.name) ||
      basenamePath(absolutePath) ||
      name;
    setProjectMeta(name, {
      absolutePath: String(absolutePath || "").trim(),
      folderName: folderName,
    });
  }

  async function removeProjectBinding(projectName) {
    const name = String(projectName || "").trim();
    if (!name) return;
    await deleteHandle(name);
    clearProjectMeta(name);
  }

  async function renameProjectBinding(fromName, toName) {
    const from = String(fromName || "").trim();
    const to = String(toName || "").trim();
    if (!from || !to || from === to) return;
    const meta = getProjectMeta(from);
    const handle = await getHandle(from);
    if (handle) {
      await putHandle(to, handle);
      await deleteHandle(from);
    }
    if (meta) {
      setProjectMeta(to, meta);
      clearProjectMeta(from);
    }
  }

  global.UndertwigLocalFs = {
    supportsDirectoryPicker: supportsDirectoryPicker,
    pickProjectDirectory: pickProjectDirectory,
    collectFiles: collectFiles,
    putHandle: putHandle,
    getHandle: getHandle,
    deleteHandle: deleteHandle,
    ensureReadWritePermission: ensureReadWritePermission,
    saveProjectToDirectory: saveProjectToDirectory,
    hasBoundDirectory: hasBoundDirectory,
    getProjectMeta: getProjectMeta,
    setProjectMeta: setProjectMeta,
    clearProjectMeta: clearProjectMeta,
    bindProject: bindProject,
    removeProjectBinding: removeProjectBinding,
    renameProjectBinding: renameProjectBinding,
    verifyLocalBinding: verifyLocalBinding,
    basenamePath: basenamePath,
  };
})(window);
