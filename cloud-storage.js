(function (global) {
  const CLOUD_FOLDER_NAME = "Undertwig";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const TOKEN_STORAGE_KEY = "undertwig-drive-token-v1"; // kept in sync with auth.js login handoff
  const UNDERTWIG_FOLDER_KEY = "undertwig-drive-root-folder-v2";
  const PROJECT_MAP_KEY = "undertwig-drive-project-map-v2";
  const ACTIVE_FOLDER_KEY = "undertwig-drive-active-folder-v2";
  const ROLE_KEY = "undertwig-drive-role-v2";
  // Legacy keys from the single-JSON sync era — clear on load so stale IDs cannot 404.
  const LEGACY_FILE_KEYS = ["undertwig-drive-file-v1", "undertwig-drive-folder-v1"];

  const TOKEN_REQUEST_TIMEOUT_MS = 8000;
  const SILENT_TOKEN_TIMEOUT_MS = 4000;
  const INTERACTIVE_TOKEN_TIMEOUT_MS = 120000;
  const FETCH_TIMEOUT_MS = 20000;

  let memoryAccessToken = null;
  let memoryTokenExpiresAt = 0;
  let cachedUndertwigFolderId = null;
  let cachedActiveFolderId = null;
  let cachedRole = null;
  let projectFolderMap = {};
  let saveChain = Promise.resolve();

  function auth() {
    return global.UndertwigAuth;
  }

  function clearLegacyIds() {
    LEGACY_FILE_KEYS.forEach(function (key) {
      try {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } catch (_error) {
        // Ignore.
      }
    });
  }

  function readJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return fallback;
      }
      return JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {
      // Ignore.
    }
  }

  function readStoredToken() {
    try {
      const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const data = JSON.parse(raw);
      if (!data || !data.accessToken || !data.expiresAt) {
        return null;
      }
      if (Number(data.expiresAt) - 60000 <= Date.now()) {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        return null;
      }
      return {
        accessToken: String(data.accessToken),
        expiresAt: Number(data.expiresAt),
      };
    } catch (_error) {
      return null;
    }
  }

  function writeStoredToken(accessToken, expiresAt) {
    try {
      sessionStorage.setItem(
        TOKEN_STORAGE_KEY,
        JSON.stringify({ accessToken: accessToken, expiresAt: expiresAt })
      );
    } catch (_error) {
      // Ignore.
    }
  }

  function loadProjectMap() {
    const map = readJsonStorage(PROJECT_MAP_KEY, {});
    projectFolderMap = map && typeof map === "object" ? map : {};
  }

  function persistProjectMap() {
    writeJsonStorage(PROJECT_MAP_KEY, projectFolderMap);
  }

  function readActiveFolderId() {
    try {
      return localStorage.getItem(ACTIVE_FOLDER_KEY) || null;
    } catch (_error) {
      return null;
    }
  }

  function writeActiveFolderId(folderId) {
    try {
      if (folderId) {
        localStorage.setItem(ACTIVE_FOLDER_KEY, String(folderId));
      } else {
        localStorage.removeItem(ACTIVE_FOLDER_KEY);
      }
    } catch (_error) {
      // Ignore.
    }
    cachedActiveFolderId = folderId || null;
  }

  function writeRole(role) {
    cachedRole = role || null;
    try {
      if (role) {
        localStorage.setItem(ROLE_KEY, String(role));
      } else {
        localStorage.removeItem(ROLE_KEY);
      }
    } catch (_error) {
      // Ignore.
    }
  }

  function readRole() {
    try {
      return localStorage.getItem(ROLE_KEY) || null;
    } catch (_error) {
      return null;
    }
  }

  function isCollaborator() {
    return cachedRole === "writer" || cachedRole === "reader";
  }

  function forgetAccessToken() {
    memoryAccessToken = null;
    memoryTokenExpiresAt = 0;
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (_error) {
      // Ignore.
    }
  }

  function clearToken() {
    if (
      memoryAccessToken &&
      global.google &&
      global.google.accounts &&
      global.google.accounts.oauth2 &&
      typeof global.google.accounts.oauth2.revoke === "function"
    ) {
      try {
        global.google.accounts.oauth2.revoke(memoryAccessToken);
      } catch (_error) {
        // Best-effort.
      }
    }
    forgetAccessToken();
    writeRole(null);
  }

  function hydrateTokenFromStorage() {
    if (memoryAccessToken && memoryTokenExpiresAt - 60000 > Date.now()) {
      return true;
    }
    const stored = readStoredToken();
    if (!stored) {
      return false;
    }
    memoryAccessToken = stored.accessToken;
    memoryTokenExpiresAt = stored.expiresAt;
    return true;
  }

  function rememberToken(tokenResponse) {
    memoryAccessToken = tokenResponse.access_token;
    const expiresIn = Number(tokenResponse.expires_in) || 3600;
    memoryTokenExpiresAt = Date.now() + expiresIn * 1000;
    writeStoredToken(memoryAccessToken, memoryTokenExpiresAt);
    return memoryAccessToken;
  }

  /** Accept a token from another Undertwig OAuth helper (e.g. invite combined scopes). */
  function acceptTokenResponse(tokenResponse) {
    if (!tokenResponse || !tokenResponse.access_token) {
      throw new Error("Missing Google access token.");
    }
    return rememberToken(tokenResponse);
  }

  function withTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || "Google Cloud request timed out.")), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  async function ensureGisOauth() {
    await auth().loadGoogleIdentityServices();
    await waitForOauthClient();
  }

  function waitForOauthClient() {
    return new Promise((resolve, reject) => {
      if (global.google && global.google.accounts && global.google.accounts.oauth2) {
        resolve();
        return;
      }
      const started = Date.now();
      const timer = setInterval(() => {
        if (global.google && global.google.accounts && global.google.accounts.oauth2) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(new Error("Google authorization library failed to load."));
        }
      }, 50);
    });
  }

  function describeOauthError(response) {
    if (response.error === "access_denied") {
      return "Google Cloud storage permission was denied.";
    }
    if (response.error === "popup_closed_by_user") {
      return "Google Cloud storage permission popup was closed.";
    }
    return response.error_description || response.error || "Google Cloud storage authorization failed.";
  }

  async function requestOauthToken(forcePrompt, timeoutMs) {
    const session = auth().readSession();
    if (!session) {
      throw new Error("Sign in to use Google Cloud storage.");
    }
    const clientId = auth().getConfig().googleClientId;
    if (!clientId) {
      throw new Error("Google Cloud storage is not configured.");
    }
    // Awaiting script load before requestAccessToken() breaks the user-gesture chain and
    // browsers report popup_failed_to_open. Warm GIS before the click; only wait here if needed.
    if (!(global.google && global.google.accounts && global.google.accounts.oauth2)) {
      await ensureGisOauth();
      throw new Error(
        "Google permission UI finished loading. Click Connect (or Send invite) again to open the permission popup."
      );
    }
    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : TOKEN_REQUEST_TIMEOUT_MS;

    const token = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        handler(value);
      };
      const timer = setTimeout(() => {
        finish(
          reject,
          new Error(
            forcePrompt
              ? "Google Cloud authorization timed out while waiting for the permission popup. Check Brave Shields/popups, then click Connect again."
              : "Google Cloud authorization needs a permission popup. Click Connect under the file tree."
          )
        );
      }, waitMs);

      try {
        const client = global.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          prompt: forcePrompt ? "consent" : "",
          hint: session.email,
          callback: (response) => {
            if (response && response.error) {
              finish(reject, new Error(describeOauthError(response)));
              return;
            }
            if (!response || !response.access_token) {
              finish(reject, new Error("Google did not return a cloud storage access token."));
              return;
            }
            finish(resolve, response);
          },
          error_callback: (error) => {
            const message =
              (error && (error.message || error.type)) || "Google cloud storage authorization failed.";
            if (/popup/i.test(message)) {
              finish(
                reject,
                new Error(
                  "Browser blocked the Google permission popup. Allow popups for this site, then click Connect again."
                )
              );
              return;
            }
            finish(reject, new Error(message));
          },
        });
        client.requestAccessToken();
      } catch (error) {
        finish(reject, error);
      }
    });

    return rememberToken(token);
  }

  async function getAccessToken(options) {
    const forcePrompt = Boolean(options && options.forcePrompt);
    const interactive = Boolean(options && options.interactive);
    const allowConsentRetry = Boolean(options && options.allowConsentRetry);
    const timeoutMs = options && options.timeoutMs;
    if (!forcePrompt && !interactive && hydrateTokenFromStorage()) {
      return memoryAccessToken;
    }
    try {
      if (interactive && !forcePrompt) {
        return await requestOauthToken(false, timeoutMs || INTERACTIVE_TOKEN_TIMEOUT_MS);
      }
      return await requestOauthToken(
        forcePrompt,
        timeoutMs || (forcePrompt || interactive ? INTERACTIVE_TOKEN_TIMEOUT_MS : SILENT_TOKEN_TIMEOUT_MS)
      );
    } catch (error) {
      const message = (error && error.message) || "";
      // Never retry with a second popup after an await — browsers will block it.
      if (/popup/i.test(message) || /Click Connect/i.test(message) || /finished loading/i.test(message)) {
        throw error;
      }
      if (interactive && !forcePrompt) {
        throw new Error(
          message + " Click Connect again if Google asks for Drive permission."
        );
      }
      if (!forcePrompt && allowConsentRetry) {
        throw new Error(
          message + " Click Connect under the file tree to grant Google Drive permission."
        );
      }
      throw error;
    }
  }

  async function connect(options) {
    const opts = options || {};
    if (opts.interactive || opts.forcePrompt) {
      return getAccessToken({
        interactive: true,
        forcePrompt: Boolean(opts.forcePrompt),
        timeoutMs: INTERACTIVE_TOKEN_TIMEOUT_MS,
      });
    }
    return getAccessToken({
      forcePrompt: false,
      allowConsentRetry: Boolean(opts.allowConsentRetry),
      timeoutMs: opts.timeoutMs || SILENT_TOKEN_TIMEOUT_MS,
    });
  }

  function mergeAbortSignals(signals) {
    const controller = new AbortController();
    const onAbort = () => {
      try {
        controller.abort();
      } catch (_error) {
        // Ignore.
      }
    };
    signals.forEach((signal) => {
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return controller.signal;
  }

  async function driveFetch(url, init, retried) {
    const token = await getAccessToken();
    const headers = Object.assign({}, (init && init.headers) || {}, {
      Authorization: "Bearer " + token,
    });
    const timeout =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
        : null;
    const userSignal = init && init.signal;
    const signal = timeout || userSignal ? mergeAbortSignals([timeout, userSignal].filter(Boolean)) : undefined;

    let response;
    try {
      const request = fetch(
        url,
        Object.assign({}, init, { headers: headers, credentials: "omit", signal: signal })
      );
      response = timeout
        ? await request
        : await withTimeout(request, FETCH_TIMEOUT_MS, "Google Drive request timed out.");
    } catch (error) {
      if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("Google Drive request timed out.");
      }
      throw error;
    }

    if (response.status === 401 && !retried) {
      forgetAccessToken();
      await getAccessToken({ forcePrompt: false, timeoutMs: SILENT_TOKEN_TIMEOUT_MS });
      return driveFetch(url, init, true);
    }
    return response;
  }

  async function readDriveError(response, fallback) {
    try {
      const payload = await response.json();
      if (payload && payload.error && payload.error.message) {
        return payload.error.message;
      }
    } catch (_error) {
      // Ignore.
    }
    return fallback + " (HTTP " + response.status + ")";
  }

  async function driveSearch(query, pageSize) {
    const url =
      DRIVE_API +
      "/files?fields=files(id,name,mimeType,modifiedTime,owners,capabilities)&q=" +
      encodeURIComponent(query) +
      "&pageSize=" +
      (pageSize || 100) +
      "&spaces=drive";
    const response = await driveFetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not search Google Drive."));
    }
    const payload = await response.json();
    return (payload && payload.files) || [];
  }

  async function createDriveFolder(name, parentId) {
    const metadata = {
      name: name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId) {
      metadata.parents = [parentId];
    }
    const response = await driveFetch(DRIVE_API + "/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not create Drive folder."));
    }
    return response.json();
  }

  function clearFolderCaches() {
    cachedUndertwigFolderId = null;
    projectFolderMap = {};
    persistProjectMap();
    writeActiveFolderId(null);
    try {
      localStorage.removeItem(UNDERTWIG_FOLDER_KEY);
    } catch (_error) {
      // Ignore.
    }
  }

  function clearCollaboratorState() {
    writeRole(null);
    writeActiveFolderId(null);
  }

  function isDriveFolderMeta(meta) {
    return Boolean(
      meta &&
        !meta.trashed &&
        meta.mimeType === "application/vnd.google-apps.folder"
    );
  }

  async function fetchDriveFileMeta(fileId, fields) {
    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(fileId) +
        "?fields=" +
        encodeURIComponent(fields || "id,name,mimeType,trashed"),
      { method: "GET" }
    );
    if (!response.ok) {
      return null;
    }
    return response.json();
  }

  async function ensureUndertwigFolder() {
    if (cachedUndertwigFolderId) {
      const meta = await fetchDriveFileMeta(cachedUndertwigFolderId, "id,trashed,mimeType");
      if (isDriveFolderMeta(meta)) {
        return cachedUndertwigFolderId;
      }
      cachedUndertwigFolderId = null;
      try {
        localStorage.removeItem(UNDERTWIG_FOLDER_KEY);
      } catch (_error) {
        // Ignore.
      }
    }

    try {
      cachedUndertwigFolderId = localStorage.getItem(UNDERTWIG_FOLDER_KEY) || null;
    } catch (_error) {
      cachedUndertwigFolderId = null;
    }

    if (cachedUndertwigFolderId) {
      const meta = await fetchDriveFileMeta(cachedUndertwigFolderId, "id,trashed,mimeType");
      if (isDriveFolderMeta(meta)) {
        return cachedUndertwigFolderId;
      }
      cachedUndertwigFolderId = null;
      try {
        localStorage.removeItem(UNDERTWIG_FOLDER_KEY);
      } catch (_error) {
        // Ignore.
      }
    }

    const existing = await driveSearch(
      "name = '" +
        CLOUD_FOLDER_NAME +
        "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      1
    );
    if (existing[0] && existing[0].id) {
      cachedUndertwigFolderId = existing[0].id;
    } else {
      const created = await createDriveFolder(CLOUD_FOLDER_NAME, null);
      cachedUndertwigFolderId = created.id;
    }
    try {
      localStorage.setItem(UNDERTWIG_FOLDER_KEY, cachedUndertwigFolderId);
    } catch (_error) {
      // Ignore.
    }
    return cachedUndertwigFolderId;
  }

  async function ensureChildFolder(parentId, name) {
    const existing = await driveSearch(
      "name = '" +
        name.replace(/'/g, "\\'") +
        "' and '" +
        parentId +
        "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      1
    );
    if (existing[0] && existing[0].id) {
      return existing[0].id;
    }
    const created = await createDriveFolder(name, parentId);
    return created.id;
  }

  async function ensureProjectFolder(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      throw new Error("Missing project name.");
    }
    if (projectFolderMap[name]) {
      const id = projectFolderMap[name];
      const meta = await fetchDriveFileMeta(id, "id,trashed,mimeType");
      if (isDriveFolderMeta(meta)) {
        writeActiveFolderId(id);
        return id;
      }
      delete projectFolderMap[name];
      persistProjectMap();
      if (cachedActiveFolderId === id) {
        writeActiveFolderId(null);
      }
    }

    const rootId = await ensureUndertwigFolder();
    const folderId = await ensureChildFolder(rootId, name);
    projectFolderMap[name] = folderId;
    persistProjectMap();
    writeActiveFolderId(folderId);
    return folderId;
  }

  function mimeForPath(path) {
    const lower = String(path || "").toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".tex")) return "text/x-tex";
    if (lower.endsWith(".bib")) return "text/plain";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".csv") || lower.endsWith(".log")) {
      return "text/plain";
    }
    return "application/octet-stream";
  }

  function base64ToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType || "application/octet-stream" });
  }

  function blobToBase64(blob) {
    return blob.arrayBuffer().then(function (buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      bytes.forEach(function (byte) {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary);
    });
  }

  async function listChildren(folderId) {
    return driveSearch("'" + folderId + "' in parents and trashed = false", 100);
  }

  async function ensurePathFolders(rootFolderId, relativeDir) {
    const parts = String(relativeDir || "")
      .split("/")
      .filter(Boolean);
    let parentId = rootFolderId;
    for (let i = 0; i < parts.length; i += 1) {
      parentId = await ensureChildFolder(parentId, parts[i]);
    }
    return parentId;
  }

  async function findNamedChild(parentId, name, mimeType) {
    let query =
      "name = '" + name.replace(/'/g, "\\'") + "' and '" + parentId + "' in parents and trashed = false";
    if (mimeType) {
      query += " and mimeType = '" + mimeType + "'";
    }
    const files = await driveSearch(query, 1);
    return files[0] || null;
  }

  async function uploadFileToFolder(parentId, fileName, fileEntry, existingId) {
    const mime = mimeForPath(fileName);
    const bodyBlob = fileEntry.binary
      ? base64ToBlob(fileEntry.content, mime)
      : new Blob([fileEntry.content || ""], { type: mime });

    const metadata = {
      name: fileName,
      mimeType: mime,
    };
    if (!existingId) {
      metadata.parents = [parentId];
    }

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", bodyBlob);

    const url = existingId
      ? DRIVE_UPLOAD + "/files/" + encodeURIComponent(existingId) + "?uploadType=multipart&fields=id,name"
      : DRIVE_UPLOAD + "/files?uploadType=multipart&fields=id,name";

    const response = await driveFetch(url, {
      method: existingId ? "PATCH" : "POST",
      body: form,
    });
    if (!response.ok) {
      if (existingId && response.status === 404) {
        return uploadFileToFolder(parentId, fileName, fileEntry, null);
      }
      throw new Error(await readDriveError(response, "Could not upload " + fileName + " to Google Drive."));
    }
    return response.json();
  }

  function projectRelativePath(projectName, fullPath) {
    const prefix = projectName + "/";
    if (fullPath === projectName) {
      return "";
    }
    if (fullPath.indexOf(prefix) === 0) {
      return fullPath.slice(prefix.length);
    }
    return null;
  }

  function filesForProject(state, projectName) {
    const out = {};
    Object.keys(state.files || {}).forEach(function (path) {
      const rel = projectRelativePath(projectName, path);
      if (rel) {
        out[rel] = state.files[path];
      }
    });
    return out;
  }

  function foldersForProject(state, projectName) {
    const out = [];
    (state.folders || []).forEach(function (path) {
      const rel = projectRelativePath(projectName, path);
      if (rel) {
        out.push(rel);
      }
    });
    return out;
  }

  function listRootProjects(state) {
    const names = new Set();
    (state.folders || []).forEach(function (path) {
      const root = String(path || "").split("/")[0];
      if (root) {
        names.add(root);
      }
    });
    Object.keys(state.files || {}).forEach(function (path) {
      const root = String(path || "").split("/")[0];
      if (root) {
        names.add(root);
      }
    });
    return Array.from(names).sort();
  }

  async function syncFilesIntoExistingFolder(folderId, state, projectName) {
    const relativeFiles = filesForProject(state, projectName);
    const relativeFolders = foldersForProject(state, projectName);

    for (let i = 0; i < relativeFolders.length; i += 1) {
      await ensurePathFolders(folderId, relativeFolders[i]);
    }

    const paths = Object.keys(relativeFiles);
    for (let i = 0; i < paths.length; i += 1) {
      const relPath = paths[i];
      const parts = relPath.split("/");
      const fileName = parts.pop();
      const parentId = await ensurePathFolders(folderId, parts.join("/"));
      const existing = await findNamedChild(parentId, fileName, null);
      await uploadFileToFolder(parentId, fileName, relativeFiles[relPath], existing && existing.id);
    }

    writeActiveFolderId(folderId);
    return folderId;
  }

  async function syncOneProject(state, projectName) {
    try {
      const folderId = await ensureProjectFolder(projectName);
      await syncFilesIntoExistingFolder(folderId, state, projectName);
      writeRole("owner");
      return folderId;
    } catch (error) {
      const message = (error && error.message) || "";
      if (!/File not found|not found|404/i.test(message)) {
        throw error;
      }
      // Stale cached IDs (often a legacy JSON file) — rebuild Undertwig folders once.
      clearFolderCaches();
      const folderId = await ensureProjectFolder(projectName);
      await syncFilesIntoExistingFolder(folderId, state, projectName);
      writeRole("owner");
      return folderId;
    }
  }

  async function saveProject(state, options) {
    const opts = options || {};
    const run = async function () {
      await connect();
      const projectName =
        opts.projectName || inferProjectName(state.activeFile) || listRootProjects(state)[0];

      // Collaborators must write into the owner's shared folder — never create Undertwig/ on their account.
      if (isCollaborator()) {
        const sharedId = getProjectFolderId();
        if (!sharedId) {
          throw new Error("Missing shared project folder. Open the invite link again.");
        }
        if (!projectName) {
          throw new Error("Select a file inside the shared project before saving.");
        }
        const meta = await refreshProjectMeta(sharedId);
        if (!meta) {
          throw new Error("Shared project folder is no longer accessible.");
        }
        await syncFilesIntoExistingFolder(sharedId, state, projectName);
        return { folderIds: [sharedId], role: cachedRole };
      }

      const projects = opts.projectName ? [opts.projectName] : listRootProjects(state);
      if (!projects.length) {
        await ensureUndertwigFolder();
        writeRole("owner");
        return { folderIds: [] };
      }
      const folderIds = [];
      for (let i = 0; i < projects.length; i += 1) {
        folderIds.push(await syncOneProject(state, projects[i]));
      }
      return { folderIds: folderIds, role: "owner" };
    };

    saveChain = saveChain.then(run, run);
    return saveChain;
  }

  async function listFolderTree(folderId, prefix) {
    const entries = [];
    const children = await listChildren(folderId);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      const path = prefix ? prefix + "/" + child.name : child.name;
      if (child.mimeType === "application/vnd.google-apps.folder") {
        entries.push({ type: "folder", path: path, id: child.id });
        const nested = await listFolderTree(child.id, path);
        entries.push.apply(entries, nested);
      } else {
        entries.push({ type: "file", path: path, id: child.id, name: child.name, mimeType: child.mimeType });
      }
    }
    return entries;
  }

  async function downloadDriveFile(fileId, asBinary) {
    const response = await driveFetch(DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media", {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not download Drive file."));
    }
    if (asBinary) {
      return blobToBase64(await response.blob());
    }
    return response.text();
  }

  function isBinaryMime(mimeType, path) {
    if (mimeType && mimeType.indexOf("text/") === 0) {
      return false;
    }
    if (mimeType === "application/json") {
      return false;
    }
    const lower = String(path || "").toLowerCase();
    return !(
      lower.endsWith(".tex") ||
      lower.endsWith(".bib") ||
      lower.endsWith(".txt") ||
      lower.endsWith(".md") ||
      lower.endsWith(".csv") ||
      lower.endsWith(".json") ||
      lower.endsWith(".log") ||
      lower.endsWith(".sty") ||
      lower.endsWith(".cls")
    );
  }

  async function loadFolderAsProject(folderId, projectName) {
    const meta = await refreshProjectMeta(folderId);
    const name =
      projectName ||
      (meta && meta.name) ||
      "SharedProject";
    const entries = await listFolderTree(folderId, "");
    const folders = [];
    const files = {};

    folders.push(name);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const fullPath = name + "/" + entry.path;
      if (entry.type === "folder") {
        folders.push(fullPath);
      } else {
        const binary = isBinaryMime(entry.mimeType, entry.path);
        const content = await downloadDriveFile(entry.id, binary);
        files[fullPath] = {
          name: entry.name,
          content: content,
          binary: binary,
        };
      }
    }

    let activeFile = "";
    const preferred = name + "/main.tex";
    if (files[preferred]) {
      activeFile = preferred;
    } else {
      const keys = Object.keys(files);
      activeFile = keys.sort()[0] || "";
    }

    writeActiveFolderId(folderId);
    projectFolderMap[name] = folderId;
    persistProjectMap();

    return {
      activeFile: activeFile,
      folders: folders,
      files: files,
      projectName: name,
      role: cachedRole,
    };
  }

  async function refreshProjectMeta(folderId) {
    const id = folderId || getProjectFolderId();
    if (!id) {
      writeRole(null);
      return null;
    }
    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(id) +
        "?fields=id,name,mimeType,owners,capabilities,shared,webViewLink,trashed",
      { method: "GET" }
    );
    if (!response.ok) {
      if (response.status === 404) {
        if (cachedActiveFolderId === id) {
          writeActiveFolderId(null);
        }
        Object.keys(projectFolderMap).forEach(function (key) {
          if (projectFolderMap[key] === id) {
            delete projectFolderMap[key];
          }
        });
        persistProjectMap();
        return null;
      }
      throw new Error(await readDriveError(response, "Could not read project folder metadata."));
    }
    const meta = await response.json();
    if (meta.trashed) {
      return null;
    }

    // Reject legacy single-JSON sync targets so invites never share undertwig-project-v1.json again.
    if (meta.mimeType && meta.mimeType !== "application/vnd.google-apps.folder") {
      if (cachedActiveFolderId === id) {
        writeActiveFolderId(null);
      }
      Object.keys(projectFolderMap).forEach(function (key) {
        if (projectFolderMap[key] === id) {
          delete projectFolderMap[key];
        }
      });
      persistProjectMap();
      return null;
    }

    const session = auth().readSession();
    const email = session && session.email ? String(session.email).toLowerCase() : "";
    const owners = Array.isArray(meta.owners) ? meta.owners : [];
    const isOwner = owners.some(function (owner) {
      return owner && owner.emailAddress && String(owner.emailAddress).toLowerCase() === email;
    });
    if (isOwner || (meta.capabilities && meta.capabilities.canShare)) {
      writeRole("owner");
    } else if (meta.capabilities && meta.capabilities.canEdit === false) {
      writeRole("reader");
    } else {
      writeRole("writer");
    }
    return meta;
  }

  async function joinSharedProject(folderId) {
    const id = String(folderId || "").trim();
    if (!id) {
      throw new Error("Missing shared project id.");
    }
    await connect();
    writeActiveFolderId(id);
    const meta = await refreshProjectMeta(id);
    if (!meta) {
      throw new Error(
        "That invite does not point to a shared project folder. Ask the owner to send a new invite after connecting Google Drive."
      );
    }
    const project = await loadFolderAsProject(id, meta.name);
    if (!project || !Object.keys(project.files || {}).length) {
      throw new Error("Shared project folder was empty or inaccessible.");
    }
    // Invitees edit the owner's folder; never treat them as creating their own Undertwig copy.
    if (!isOwnerEmail(meta)) {
      writeRole(cachedRole === "reader" ? "reader" : "writer");
    }
    return project;
  }

  function isOwnerEmail(meta) {
    const session = auth().readSession();
    const email = session && session.email ? String(session.email).toLowerCase() : "";
    const owners = Array.isArray(meta && meta.owners) ? meta.owners : [];
    return owners.some(function (owner) {
      return owner && owner.emailAddress && String(owner.emailAddress).toLowerCase() === email;
    });
  }

  async function shareProjectWithEmail(emailAddress, role, projectName) {
    const email = String(emailAddress || "").trim();
    if (!email) {
      throw new Error("Enter an email address.");
    }
    await connect();

    const name = String(projectName || "").trim();
    if (!name) {
      throw new Error("Select a project folder before inviting collaborators.");
    }

    // Always share the owner's Undertwig/<project> folder — never a legacy JSON file.
    let folderId = await ensureProjectFolder(name);
    let meta = await refreshProjectMeta(folderId);
    if (!meta || meta.mimeType !== "application/vnd.google-apps.folder") {
      writeActiveFolderId(null);
      delete projectFolderMap[name];
      persistProjectMap();
      folderId = await ensureProjectFolder(name);
      meta = await refreshProjectMeta(folderId);
    }
    if (!meta || meta.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("Could not resolve a Drive folder to share for this project.");
    }
    if (cachedRole && cachedRole !== "owner") {
      throw new Error("Only the project owner can invite collaborators.");
    }

    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(folderId) +
        "/permissions?sendNotificationEmail=false&fields=id,role,emailAddress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "user",
          role: role || "writer",
          emailAddress: email,
        }),
      }
    );
    if (!response.ok) {
      const detail = await readDriveError(response, "Could not share the project folder on Google Drive.");
      if (/already|exists/i.test(detail)) {
        return { folderId: folderId, email: email, role: role || "writer", name: meta.name };
      }
      throw new Error(detail);
    }
    writeActiveFolderId(folderId);
    writeRole("owner");
    return { folderId: folderId, email: email, role: role || "writer", name: meta.name };
  }

  async function probeConnection() {
    if (!isAvailable()) {
      return { connected: false, fileId: null, role: null, reason: "not-signed-in" };
    }
    try {
      await connect();
      const activeId = getProjectFolderId();
      if (activeId) {
        const meta = await refreshProjectMeta(activeId);
        if (meta) {
          return { connected: true, fileId: activeId, role: cachedRole, reason: "ok" };
        }
      }
      // Stale collaborator role without a usable shared folder — fall back to owner workspace.
      if (isCollaborator()) {
        clearCollaboratorState();
      }
      const rootId = await ensureUndertwigFolder();
      writeRole("owner");
      return { connected: true, fileId: rootId, role: "owner", reason: "ready-no-project" };
    } catch (error) {
      const message = (error && error.message) || "connection-failed";
      if (/File not found|not found|404/i.test(message)) {
        try {
          clearFolderCaches();
          clearCollaboratorState();
          const rootId = await ensureUndertwigFolder();
          writeRole("owner");
          return { connected: true, fileId: rootId, role: "owner", reason: "rebuilt-root" };
        } catch (retryError) {
          return {
            connected: false,
            fileId: null,
            role: null,
            reason: (retryError && retryError.message) || message,
          };
        }
      }
      return {
        connected: false,
        fileId: null,
        role: null,
        reason: message,
      };
    }
  }

  async function syncProject(localState, options) {
    const opts = options || {};
    await connect();

    if (isCollaborator() && getProjectFolderId()) {
      const projectName =
        opts.projectName || inferProjectName(localState.activeFile) || listRootProjects(localState)[0];
      const sharedMeta = await refreshProjectMeta(getProjectFolderId());
      if (!sharedMeta) {
        clearCollaboratorState();
      } else {
        await saveProject(localState, { projectName: projectName });
        return {
          project: localState,
          source: "uploaded",
          role: cachedRole,
          folderId: getProjectFolderId(),
        };
      }
    }

    // Owner path: ensure Undertwig exists and upload root projects.
    try {
      await ensureUndertwigFolder();
    } catch (error) {
      const message = (error && error.message) || "";
      if (!/File not found|not found|404/i.test(message)) {
        throw error;
      }
      clearFolderCaches();
      await ensureUndertwigFolder();
    }
    const projects = listRootProjects(localState);
    if (!projects.length) {
      writeRole("owner");
      return { project: localState, source: "uploaded", role: "owner" };
    }

    const activeProject = opts.projectName || inferProjectName(localState.activeFile) || projects[0];
    await syncOneProject(localState, activeProject);
    for (let i = 0; i < projects.length; i += 1) {
      if (projects[i] !== activeProject) {
        await syncOneProject(localState, projects[i]);
      }
    }

    return {
      project: localState,
      source: "uploaded",
      role: "owner",
      folderId: getProjectFolderId(),
    };
  }

  function inferProjectName(activeFile) {
    const path = String(activeFile || "");
    if (!path || path.indexOf("/") < 0) {
      return null;
    }
    return path.split("/")[0];
  }

  function getProjectFolderId() {
    return cachedActiveFolderId || readActiveFolderId() || null;
  }

  function getProjectFileId() {
    // Back-compat alias used by UI ("Open in Google Drive").
    return getProjectFolderId() || cachedUndertwigFolderId || null;
  }

  /**
   * Return a Drive UI URL for a folder the signed-in user can open.
   * Avoids stale IDs (which show "You need access" in the Drive UI).
   */
  async function getOpenInDriveUrl(preferredId) {
    await connect();
    const candidates = [];
    const seen = {};
    const push = (id) => {
      const value = String(id || "").trim();
      if (!value || seen[value]) {
        return;
      }
      seen[value] = true;
      candidates.push(value);
    };
    push(preferredId);
    push(getProjectFolderId());
    push(cachedUndertwigFolderId);
    try {
      push(localStorage.getItem(UNDERTWIG_FOLDER_KEY));
    } catch (_error) {
      // Ignore.
    }
    Object.keys(projectFolderMap).forEach(function (name) {
      push(projectFolderMap[name]);
    });

    for (let i = 0; i < candidates.length; i += 1) {
      const meta = await fetchDriveFileMeta(
        candidates[i],
        "id,name,mimeType,trashed,webViewLink"
      );
      if (isDriveFolderMeta(meta)) {
        if (meta.webViewLink) {
          return meta.webViewLink;
        }
        return "https://drive.google.com/drive/folders/" + encodeURIComponent(meta.id);
      }
    }

    const rootId = await ensureUndertwigFolder();
    const rootMeta = await fetchDriveFileMeta(rootId, "id,mimeType,trashed,webViewLink");
    if (isDriveFolderMeta(rootMeta)) {
      if (rootMeta.webViewLink) {
        return rootMeta.webViewLink;
      }
      return "https://drive.google.com/drive/folders/" + encodeURIComponent(rootMeta.id);
    }
    return "https://drive.google.com/drive/my-drive";
  }

  function setActiveProjectFileId(folderId) {
    writeActiveFolderId(folderId);
    cachedRole = null;
  }

  function getProjectRole() {
    return cachedRole;
  }

  function buildProjectInvitePath(folderId) {
    const id = folderId || getProjectFolderId();
    if (!id) {
      return "/";
    }
    return "/?project=" + encodeURIComponent(id);
  }

  function hasAccessToken() {
    return hydrateTokenFromStorage();
  }

  /**
   * Fast reachability check using the stored Drive token only (no GIS, no folder setup).
   * Always settles within 5 seconds.
   */
  async function verifyDriveAccess() {
    if (!hydrateTokenFromStorage()) {
      return { ok: false, reason: "no-token", fileId: null };
    }

    const token = memoryAccessToken;
    const fileId = getProjectFolderId() || cachedUndertwigFolderId || null;

    try {
      const response = await Promise.race([
        fetch(DRIVE_API + "/about?fields=user", {
          method: "GET",
          credentials: "omit",
          headers: {
            Authorization: "Bearer " + token,
          },
        }),
        new Promise(function (_, reject) {
          setTimeout(function () {
            const error = new Error("timeout");
            error.name = "AbortError";
            reject(error);
          }, 5000);
        }),
      ]);

      if (response.status === 401 || response.status === 403) {
        forgetAccessToken();
        return { ok: false, reason: "unauthorized", fileId: null };
      }
      if (!response.ok) {
        return { ok: false, reason: "http-" + response.status, fileId: null };
      }

      writeRole(cachedRole || "owner");
      return { ok: true, reason: "ok", fileId: fileId };
    } catch (error) {
      const aborted =
        error && (error.name === "AbortError" || /abort|timeout/i.test(String(error.message || "")));
      return {
        ok: false,
        reason: aborted ? "timeout" : "network",
        fileId: null,
      };
    }
  }

  function isAvailable() {
    return Boolean(auth() && auth().isLoggedIn() && auth().getConfig().googleClientId);
  }

  // Startup
  clearLegacyIds();
  loadProjectMap();
  cachedActiveFolderId = readActiveFolderId();
  cachedRole = readRole();
  try {
    cachedUndertwigFolderId = localStorage.getItem(UNDERTWIG_FOLDER_KEY) || null;
  } catch (_error) {
    cachedUndertwigFolderId = null;
  }
  hydrateTokenFromStorage();

  global.UndertwigCloud = {
    DRIVE_SCOPE,
    CLOUD_FOLDER_NAME,
    isAvailable,
    hasAccessToken,
    verifyDriveAccess,
    isCollaborator,
    connect,
    getAccessToken,
    acceptTokenResponse,
    getProjectFileId,
    getOpenInDriveUrl,
    getProjectFolderId,
    getProjectRole,
    setActiveProjectFileId,
    buildProjectInvitePath,
    joinSharedProject,
    shareProjectWithEmail,
    refreshProjectMeta,
    probeConnection,
    syncProject,
    saveProject,
    listRootProjects,
    inferProjectName,
    clearToken,
    clearFolderCaches,
    clearCollaboratorState,
  };
})(window);
