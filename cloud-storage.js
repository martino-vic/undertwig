(function (global) {
  const CLOUD_FOLDER_NAME = "Undertwig";
  // Full Drive scope is required so invitees can open/edit folders the owner shared with them.
  // drive.file alone cannot access another user's shared folder via the API.
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const TOKEN_STORAGE_KEY = "undertwig-drive-token-v1"; // kept in sync with auth.js login handoff
  const UNDERTWIG_FOLDER_KEY = "undertwig-drive-root-folder-v2";
  const PROJECT_MAP_KEY = "undertwig-drive-project-map-v2";
  const ACTIVE_FOLDER_KEY = "undertwig-drive-active-folder-v2";
  const ROLE_KEY = "undertwig-drive-role-v2";
  const OWNER_EMAIL_KEY = "undertwig-drive-owner-email-v1";
  const PENDING_INVITE_KEY = "undertwig-pending-invite-project-v1";
  // Legacy keys from the single-JSON sync era — clear on load so stale IDs cannot 404.
  const LEGACY_FILE_KEYS = ["undertwig-drive-file-v1", "undertwig-drive-folder-v1"];
  const LOCK_DIR_NAME = ".undertwig-locks";
  const PROJECT_LOCK_FILE = "project.json";
  const DEVICE_ID_KEY = "undertwig-device-id-v1";
  // Abandoned rooms free quickly so a closed tab / crashed client does not brick collaborators.
  const LOCK_HEARTBEAT_STALE_MS = 45 * 1000;

  const TOKEN_REQUEST_TIMEOUT_MS = 8000;
  const SILENT_TOKEN_TIMEOUT_MS = 4000;
  const INTERACTIVE_TOKEN_TIMEOUT_MS = 120000;
  const FETCH_TIMEOUT_MS = 20000;

  let memoryAccessToken = null;
  let memoryTokenExpiresAt = 0;
  let memoryTokenScope = null;
  let cachedUndertwigFolderId = null;
  let cachedActiveFolderId = null;
  let cachedRole = null;
  let cachedOwnerEmail = null;
  let projectFolderMap = {};
  let saveChain = Promise.resolve();
  // Optional AbortSignal for the in-flight save/upload (invite / copy-link / Save).
  let activeOperationSignal = null;

  function createAbortError(message) {
    const error = new Error(message || "Cancelled.");
    error.name = "AbortError";
    return error;
  }

  function throwIfAborted(signal) {
    const active = signal || activeOperationSignal;
    if (active && active.aborted) {
      throw createAbortError();
    }
  }

  /** Reject when `signal` aborts; used to cancel waits that ignore fetch signals. */
  function abortablePromise(promise, signal) {
    const active = signal || activeOperationSignal;
    if (!active) {
      return promise;
    }
    if (active.aborted) {
      return Promise.reject(createAbortError());
    }
    return new Promise(function (resolve, reject) {
      const onAbort = function () {
        reject(createAbortError());
      };
      active.addEventListener("abort", onAbort, { once: true });
      promise.then(
        function (value) {
          active.removeEventListener("abort", onAbort);
          resolve(value);
        },
        function (error) {
          active.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

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
        scope: data.scope ? String(data.scope) : null,
      };
    } catch (_error) {
      return null;
    }
  }

  function writeStoredToken(accessToken, expiresAt, scope) {
    try {
      const payload = { accessToken: accessToken, expiresAt: expiresAt };
      if (scope) {
        payload.scope = String(scope);
      }
      sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(payload));
    } catch (_error) {
      // Ignore.
    }
  }

  function loadProjectMap() {
    const map = readJsonStorage(PROJECT_MAP_KEY, {});
    projectFolderMap = map && typeof map === "object" ? map : {};
    // Scrub bad mappings from older builds that pointed a project at Undertwig itself.
    let changed = false;
    Object.keys(projectFolderMap).forEach(function (key) {
      if (String(key || "").toLowerCase() === String(CLOUD_FOLDER_NAME).toLowerCase()) {
        delete projectFolderMap[key];
        changed = true;
        return;
      }
      const entry = normalizeMapEntry(projectFolderMap[key]);
      if (
        entry &&
        cachedUndertwigFolderId &&
        String(entry.id) === String(cachedUndertwigFolderId)
      ) {
        delete projectFolderMap[key];
        changed = true;
      }
    });
    if (changed) {
      persistProjectMap();
    }
  }

  function persistProjectMap() {
    writeJsonStorage(PROJECT_MAP_KEY, projectFolderMap);
  }

  function normalizeMapEntry(value) {
    if (!value) {
      return null;
    }
    if (typeof value === "string") {
      return { id: value, role: null };
    }
    if (value && value.id) {
      return { id: String(value.id), role: value.role ? String(value.role) : null };
    }
    return null;
  }

  function getMappedFolderId(name) {
    const entry = normalizeMapEntry(projectFolderMap[name]);
    return entry ? entry.id : null;
  }

  function getMappedRole(name) {
    const entry = normalizeMapEntry(projectFolderMap[name]);
    return entry ? entry.role : null;
  }

  function setMappedProject(name, id, role) {
    const key = String(name || "").trim();
    const folderId = String(id || "").trim();
    if (!key || !folderId) {
      return;
    }
    // Never treat the Undertwig root as a project folder — that makes Save try to
    // sync/delete every project under Drive / Undertwig /.
    if (key.toLowerCase() === String(CLOUD_FOLDER_NAME).toLowerCase()) {
      return;
    }
    if (cachedUndertwigFolderId && String(cachedUndertwigFolderId) === folderId) {
      return;
    }
    // Do not demote an owned project mapping to a shared/writer mapping.
    if (isSharedProjectRole(role) && getMappedRole(key) === "owner") {
      return;
    }
    projectFolderMap[key] = {
      id: folderId,
      role: role ? String(role) : null,
    };
    persistProjectMap();
  }

  function removeMappedProject(name) {
    const key = String(name || "").trim();
    if (!key || !Object.prototype.hasOwnProperty.call(projectFolderMap, key)) {
      return;
    }
    delete projectFolderMap[key];
    persistProjectMap();
  }

  function removeMappedFolderId(folderId) {
    const id = String(folderId || "").trim();
    if (!id) {
      return;
    }
    Object.keys(projectFolderMap).forEach(function (key) {
      if (getMappedFolderId(key) === id) {
        delete projectFolderMap[key];
      }
    });
    persistProjectMap();
  }

  function isSharedProjectRole(role) {
    return role === "writer" || role === "reader";
  }

  function isCurrentProjectShared(projectName) {
    const name = String(projectName || "").trim();
    if (name && isSharedProjectRole(getMappedRole(name))) {
      return true;
    }
    if (!isCollaborator()) {
      return false;
    }
    if (!name) {
      return true;
    }
    const mappedId = getMappedFolderId(name);
    return Boolean(mappedId && mappedId === getProjectFolderId());
  }

  function roleFromMeta(meta) {
    // Ownership is only by Drive owners list — not canShare (writers on shared folders often can share).
    if (isOwnerEmail(meta)) {
      return "owner";
    }
    if (meta && meta.capabilities && meta.capabilities.canEdit === false) {
      return "reader";
    }
    return "writer";
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
    if (!role) {
      writeOwnerEmail(null);
    }
  }

  function readRole() {
    try {
      return localStorage.getItem(ROLE_KEY) || null;
    } catch (_error) {
      return null;
    }
  }

  function writeOwnerEmail(email) {
    const value = String(email || "").trim() || null;
    cachedOwnerEmail = value;
    try {
      if (value) {
        localStorage.setItem(OWNER_EMAIL_KEY, value);
      } else {
        localStorage.removeItem(OWNER_EMAIL_KEY);
      }
    } catch (_error) {
      // Ignore.
    }
  }

  function readOwnerEmail() {
    try {
      return String(localStorage.getItem(OWNER_EMAIL_KEY) || "").trim() || null;
    } catch (_error) {
      return null;
    }
  }

  function ownerEmailFromMeta(meta) {
    const owners = Array.isArray(meta && meta.owners) ? meta.owners : [];
    for (let i = 0; i < owners.length; i += 1) {
      const email = owners[i] && owners[i].emailAddress;
      if (email) {
        return String(email).trim();
      }
    }
    return null;
  }

  function getProjectOwnerEmail() {
    return cachedOwnerEmail || readOwnerEmail() || null;
  }

  function isCollaborator() {
    return cachedRole === "writer" || cachedRole === "reader";
  }

  function scopeIncludesDriveAccess(scope) {
    // Accept full drive or legacy drive.file grants.
    return /(?:^|[\s+])(?:https:\/\/www\.googleapis\.com\/auth\/)?drive(?:\.file)?(?:[\s+]|$)/i.test(
      String(scope || "").replace(/\+/g, " ")
    );
  }

  function rememberPendingInvite(folderId) {
    const id = String(folderId || "").trim();
    if (!id) {
      return;
    }
    try {
      localStorage.setItem(PENDING_INVITE_KEY, id);
    } catch (_error) {
      // Ignore.
    }
  }

  function readPendingInvite() {
    try {
      return String(localStorage.getItem(PENDING_INVITE_KEY) || "").trim() || null;
    } catch (_error) {
      return null;
    }
  }

  function clearPendingInvite() {
    try {
      localStorage.removeItem(PENDING_INVITE_KEY);
    } catch (_error) {
      // Ignore.
    }
  }

  function inviteEditorPath(folderId) {
    const id = String(folderId || "").trim();
    if (!id) {
      return "/";
    }
    return "/?project=" + encodeURIComponent(id);
  }

  function isInsufficientScopeMessage(message) {
    // Do not treat generic Drive "insufficientPermissions" (often "no access to this file")
    // as a missing OAuth scope — that was forcing invitees through a second Google login.
    return /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|Request had insufficient authentication scopes/i.test(
      String(message || "")
    );
  }

  function forgetAccessToken() {
    memoryAccessToken = null;
    memoryTokenExpiresAt = 0;
    memoryTokenScope = null;
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
    memoryTokenScope = stored.scope || null;
    return true;
  }

  function rememberToken(tokenResponse) {
    memoryAccessToken = tokenResponse.access_token;
    const expiresIn = Number(tokenResponse.expires_in) || 3600;
    memoryTokenExpiresAt = Date.now() + expiresIn * 1000;
    memoryTokenScope = tokenResponse.scope ? String(tokenResponse.scope) : memoryTokenScope;
    writeStoredToken(memoryAccessToken, memoryTokenExpiresAt, memoryTokenScope);
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
    const requestInit = init || {};
    const userSignal = requestInit.signal || activeOperationSignal;
    throwIfAborted(userSignal);
    const token = await abortablePromise(getAccessToken(), userSignal);
    throwIfAborted(userSignal);
    const headers = Object.assign({}, requestInit.headers || {}, {
      Authorization: "Bearer " + token,
    });
    const timeout =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
        : null;
    const signal = timeout || userSignal ? mergeAbortSignals([timeout, userSignal].filter(Boolean)) : undefined;

    let response;
    try {
      const request = fetch(
        url,
        Object.assign({}, requestInit, { headers: headers, credentials: "omit", signal: signal })
      );
      response = timeout
        ? await request
        : await withTimeout(request, FETCH_TIMEOUT_MS, "Google Drive request timed out.");
    } catch (error) {
      if (error && error.name === "AbortError") {
        if (userSignal && userSignal.aborted) {
          throw createAbortError();
        }
        throw new Error("Google Drive request timed out.");
      }
      if (error && error.name === "TimeoutError") {
        throw new Error("Google Drive request timed out.");
      }
      throw error;
    }

    if (response.status === 401 && !retried) {
      forgetAccessToken();
      await abortablePromise(
        getAccessToken({ forcePrompt: false, timeoutMs: SILENT_TOKEN_TIMEOUT_MS }),
        userSignal
      );
      return driveFetch(url, requestInit, true);
    }

    if (response.status === 403) {
      const detail = await readDriveError(response.clone(), "Google Drive permission denied.");
      if (isInsufficientScopeMessage(detail)) {
        forgetAccessToken();
        throw new Error(
          "Request had insufficient authentication scopes. Undertwig needs Google Drive file access. Click Retry to grant it again."
        );
      }
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
    // Do not set spaces=drive — that can hide children inside folders shared with the user.
    const url =
      DRIVE_API +
      "/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,modifiedTime,owners,capabilities)&q=" +
      encodeURIComponent(query) +
      "&pageSize=" +
      (pageSize || 100);
    const response = await driveFetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not search Google Drive."));
    }
    const payload = await response.json();
    return (payload && payload.files) || [];
  }

  /**
   * List direct children of a folder. Used for shared invite folders too — do not
   * constrain with spaces=drive (that can hide shared-with-me children).
   */
  async function listChildren(folderId, signal) {
    const all = [];
    let pageToken = "";
    const query = "'" + folderId + "' in parents and trashed = false";
    do {
      throwIfAborted(signal);
      let url =
        DRIVE_API +
        "/files?supportsAllDrives=true&includeItemsFromAllDrives=true" +
        "&pageSize=100" +
        "&fields=" +
        encodeURIComponent(
          "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,owners,capabilities)"
        ) +
        "&q=" +
        encodeURIComponent(query);
      if (pageToken) {
        url += "&pageToken=" + encodeURIComponent(pageToken);
      }
      const response = await driveFetch(url, { method: "GET", signal: signal || undefined });
      if (!response.ok) {
        throw new Error(await readDriveError(response, "Could not list Google Drive folder contents."));
      }
      const payload = await response.json();
      const files = (payload && payload.files) || [];
      for (let i = 0; i < files.length; i += 1) {
        all.push(files[i]);
      }
      pageToken = (payload && payload.nextPageToken) || "";
    } while (pageToken);
    return all;
  }

  async function createDriveFolder(name, parentId) {
    const metadata = {
      name: name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId) {
      metadata.parents = [parentId];
    }
    const response = await driveFetch(DRIVE_API + "/files?supportsAllDrives=true&fields=id,name", {
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
        "?supportsAllDrives=true&fields=" +
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
        scrubProjectMapAgainstRoot(cachedUndertwigFolderId);
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
        scrubProjectMapAgainstRoot(cachedUndertwigFolderId);
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
    scrubProjectMapAgainstRoot(cachedUndertwigFolderId);
    return cachedUndertwigFolderId;
  }

  function scrubProjectMapAgainstRoot(rootId) {
    const root = String(rootId || "").trim();
    if (!root) {
      return;
    }
    let changed = false;
    Object.keys(projectFolderMap).forEach(function (key) {
      if (String(key || "").toLowerCase() === String(CLOUD_FOLDER_NAME).toLowerCase()) {
        delete projectFolderMap[key];
        changed = true;
        return;
      }
      const entry = normalizeMapEntry(projectFolderMap[key]);
      if (entry && String(entry.id) === root) {
        delete projectFolderMap[key];
        changed = true;
      }
    });
    if (cachedActiveFolderId && String(cachedActiveFolderId) === root) {
      writeActiveFolderId(null);
    }
    if (changed) {
      persistProjectMap();
    }
  }

  async function ensureChildFolder(parentId, name) {
    const existing = await findNamedChild(parentId, name, "application/vnd.google-apps.folder");
    if (existing && existing.id) {
      return existing.id;
    }
    const created = await createDriveFolder(name, parentId);
    await maybeTransferToProjectOwner(created && created.id);
    return created.id;
  }

  async function ensureProjectFolder(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      throw new Error("Missing project name.");
    }
    if (name.toLowerCase() === String(CLOUD_FOLDER_NAME).toLowerCase()) {
      throw new Error('Project name cannot be "' + CLOUD_FOLDER_NAME + '".');
    }

    const existingId = getMappedFolderId(name);
    const existingRole = getMappedRole(name);
    if (existingId) {
      // Shared projects must keep pointing at the owner's folder — never recreate locally.
      if (isSharedProjectRole(existingRole)) {
        writeActiveFolderId(existingId);
        writeRole(existingRole);
        return existingId;
      }
      const meta = await fetchDriveFileMeta(
        existingId,
        "id,name,trashed,mimeType,parents"
      );
      const rootId = await ensureUndertwigFolder();
      const namedOk =
        isDriveFolderMeta(meta) &&
        String(meta.name || "") === name &&
        String(meta.id) !== String(rootId);
      const underUndertwig =
        namedOk &&
        Array.isArray(meta.parents) &&
        meta.parents.some(function (parentId) {
          return String(parentId) === String(rootId);
        });
      if (namedOk && underUndertwig) {
        writeActiveFolderId(existingId);
        writeRole("owner");
        return existingId;
      }
      // Stale map (Undertwig root, renamed folder, or legacy JSON id) — rebuild.
      removeMappedProject(name);
      if (cachedActiveFolderId === existingId) {
        writeActiveFolderId(null);
      }
    }

    if (isCollaborator() && isCurrentProjectShared(name)) {
      const sharedId = getProjectFolderId();
      if (!sharedId) {
        throw new Error("Missing shared project folder. Open the invite link again.");
      }
      return sharedId;
    }

    // Owner path: My Drive / Undertwig / <projectName> /
    const rootId = await ensureUndertwigFolder();
    const folderId = await ensureChildFolder(rootId, name);
    if (!folderId || String(folderId) === String(rootId)) {
      throw new Error('Could not create project folder “' + name + '” under Undertwig.');
    }
    setMappedProject(name, folderId, "owner");
    writeActiveFolderId(folderId);
    writeRole("owner");
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

  function currentSessionEmail() {
    const session = auth().readSession();
    return session && session.email ? String(session.email).toLowerCase() : "";
  }

  function fileOwnedByEmail(meta, email) {
    const want = String(email || "").toLowerCase();
    if (!want || !meta) {
      return false;
    }
    const owners = Array.isArray(meta.owners) ? meta.owners : [];
    return owners.some(function (owner) {
      return owner && owner.emailAddress && String(owner.emailAddress).toLowerCase() === want;
    });
  }

  function pickPreferredChild(matches) {
    if (!matches || !matches.length) {
      return null;
    }
    if (matches.length === 1) {
      return matches[0];
    }
    const ownerEmail = getProjectOwnerEmail();
    if (ownerEmail) {
      for (let i = 0; i < matches.length; i += 1) {
        if (fileOwnedByEmail(matches[i], ownerEmail)) {
          return matches[i];
        }
      }
    }
    return matches[0];
  }

  async function findNamedChild(parentId, name, mimeType) {
    const wantName = String(name || "");
    if (!parentId || !wantName) {
      return null;
    }
    const children = await listChildren(parentId);
    const matches = [];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child || child.name !== wantName) {
        continue;
      }
      if (mimeType && child.mimeType !== mimeType) {
        continue;
      }
      matches.push(child);
    }
    const preferred = pickPreferredChild(matches);
    // Older saves could create duplicate names owned by whoever saved last — remove our extras.
    if (preferred && matches.length > 1) {
      const me = currentSessionEmail();
      for (let i = 0; i < matches.length; i += 1) {
        const match = matches[i];
        if (!match || match.id === preferred.id) {
          continue;
        }
        if (me && fileOwnedByEmail(match, me)) {
          try {
            await removeDriveItemFromProject({
              id: match.id,
              parentId: parentId,
              owners: match.owners || [{ emailAddress: me }],
            });
          } catch (_error) {
            // Best-effort cleanup only.
          }
        }
      }
    }
    return preferred;
  }

  async function transferOwnership(fileId, emailAddress) {
    const id = String(fileId || "").trim();
    const email = String(emailAddress || "").trim();
    if (!id || !email) {
      return;
    }
    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(id) +
        "/permissions?transferOwnership=true&sendNotificationEmail=false&supportsAllDrives=true",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "user",
          role: "owner",
          emailAddress: email,
        }),
      }
    );
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not transfer Google Drive ownership."));
    }
  }

  /**
   * Keep shared-project items owned by the folder owner so every writer can delete/update them.
   */
  async function maybeTransferToProjectOwner(fileId) {
    const id = String(fileId || "").trim();
    const ownerEmail = getProjectOwnerEmail();
    const me = currentSessionEmail();
    if (!id || !ownerEmail || !me || me === String(ownerEmail).toLowerCase()) {
      return false;
    }
    try {
      await transferOwnership(id, ownerEmail);
      return true;
    } catch (_error) {
      // Best-effort: save should still succeed if transfer is blocked.
      return false;
    }
  }

  /**
   * Invitees may already own files from earlier saves — hand them back to the project owner.
   */
  async function reclaimSharedOwnershipUnderFolder(folderId) {
    const ownerEmail = getProjectOwnerEmail();
    const me = currentSessionEmail();
    if (!folderId || !ownerEmail || !me || me === String(ownerEmail).toLowerCase()) {
      return;
    }
    const remote = await listFolderTree(folderId, "");
    for (let i = 0; i < remote.length; i += 1) {
      const entry = remote[i];
      if (!entry || !entry.id) {
        continue;
      }
      if (fileOwnedByEmail(entry, me)) {
        await maybeTransferToProjectOwner(entry.id);
      }
    }
  }

  /**
   * Remove a file/folder from a shared project folder.
   * Only owners can trash via the Drive API; writers must removeParents (same as Drive UI "delete"
   * for non-owned items in a shared folder).
   */
  async function removeDriveItemFromProject(item) {
    const id = String((item && item.id) || "").trim();
    if (!id) {
      return;
    }
    const parentId = String((item && item.parentId) || "").trim();
    const me = currentSessionEmail();
    const ownedByMe = Boolean(me && fileOwnedByEmail(item, me));

    if (ownedByMe) {
      const trashed = await tryTrashDriveFile(id);
      if (trashed) {
        return;
      }
    }

    if (parentId) {
      await removeDriveParents(id, parentId);
      return;
    }

    const trashed = await tryTrashDriveFile(id);
    if (trashed) {
      return;
    }
    throw new Error(
      "Could not remove a file from Google Drive. Only the file owner can trash it; open the folder in Drive and remove it there, or ask the owner to Save after deleting."
    );
  }

  async function tryTrashDriveFile(fileId, options) {
    const opts = options || {};
    const response = await driveFetch(
      DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?supportsAllDrives=true",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true }),
        keepalive: Boolean(opts.keepalive),
      }
    );
    return response.ok;
  }

  /**
   * Best-effort trash without awaiting token refresh — for page unload.
   */
  function trashDriveFileKeepaliveSync(fileId) {
    const id = String(fileId || "").trim();
    if (!id) {
      return;
    }
    let token = memoryAccessToken;
    if (!token) {
      const stored = readStoredToken();
      token = stored && stored.accessToken;
    }
    if (!token) {
      return;
    }
    try {
      fetch(
        DRIVE_API + "/files/" + encodeURIComponent(id) + "?supportsAllDrives=true",
        {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ trashed: true }),
          credentials: "omit",
          keepalive: true,
        }
      );
    } catch (_error) {
      // Ignore unload failures.
    }
  }

  async function removeDriveParents(fileId, parentId) {
    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(fileId) +
        "?supportsAllDrives=true&removeParents=" +
        encodeURIComponent(parentId) +
        "&fields=id,parents",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }
    );
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not remove a file from the shared Google Drive folder."));
    }
  }

  async function trashDriveFile(fileId) {
    const ok = await tryTrashDriveFile(fileId);
    if (!ok) {
      throw new Error("Could not delete a file from Google Drive.");
    }
  }

  function pruneNestedDriveDeletions(items) {
    const folderPaths = items
      .filter(function (item) {
        return item && item.type === "folder" && item.path;
      })
      .map(function (item) {
        return item.path;
      })
      .sort();
    return items.filter(function (item) {
      if (!item || !item.path) {
        return false;
      }
      for (let i = 0; i < folderPaths.length; i += 1) {
        const folder = folderPaths[i];
        if (item.path !== folder && item.path.indexOf(folder + "/") === 0) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Remote Drive paths under the project folder that are no longer present locally.
   */
  async function findDriveDeletions(folderId, state, projectName) {
    const localFiles = filesForProject(state, projectName);
    const localFolderSet = {};
    foldersForProject(state, projectName).forEach(function (path) {
      localFolderSet[path] = true;
    });
    Object.keys(localFiles).forEach(function (path) {
      const parts = path.split("/");
      parts.pop();
      let built = "";
      for (let i = 0; i < parts.length; i += 1) {
        built = built ? built + "/" + parts[i] : parts[i];
        localFolderSet[built] = true;
      }
    });

    const remote = await listFolderTree(folderId, "");
    const deletions = [];
    for (let i = 0; i < remote.length; i += 1) {
      const entry = remote[i];
      if (!entry || !entry.path || !entry.id) {
        continue;
      }
      // Never remove edit-lock infrastructure via project Save.
      if (isLockInfraPath(entry.path)) {
        continue;
      }
      if (entry.type === "file") {
        if (!Object.prototype.hasOwnProperty.call(localFiles, entry.path)) {
          deletions.push({
            path: entry.path,
            id: entry.id,
            parentId: entry.parentId || null,
            type: "file",
            name: entry.name || entry.path,
            owners: entry.owners || [],
          });
        }
        continue;
      }
      if (entry.type === "folder" && !localFolderSet[entry.path]) {
        deletions.push({
          path: entry.path,
          id: entry.id,
          parentId: entry.parentId || null,
          type: "folder",
          name: entry.name || entry.path,
          owners: entry.owners || [],
        });
      }
    }
    return pruneNestedDriveDeletions(deletions);
  }

  async function resolveExistingProjectFolderId(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      return null;
    }
    let folderId = getMappedFolderId(name) || null;
    if (!folderId && isCurrentProjectShared(name) && getProjectFolderId()) {
      folderId = getProjectFolderId();
    }
    if (!folderId && isCollaborator() && getProjectFolderId()) {
      folderId = getProjectFolderId();
    }
    if (folderId) {
      const meta = await fetchDriveFileMeta(folderId, "id,trashed,mimeType");
      if (isDriveFolderMeta(meta)) {
        return folderId;
      }
    }
    try {
      const rootId = await ensureUndertwigFolder();
      const children = await listChildren(rootId);
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (
          child &&
          child.mimeType === "application/vnd.google-apps.folder" &&
          child.name === name
        ) {
          setMappedProject(name, child.id, getMappedRole(name) || "owner");
          return child.id;
        }
      }
    } catch (_error) {
      // Ignore lookup failures; caller treats this as "nothing to delete".
    }
    return null;
  }

  async function previewSaveDeletions(state, options) {
    const opts = options || {};
    const signal = opts.signal;
    const previousSignal = activeOperationSignal;
    if (signal) {
      activeOperationSignal = signal;
    }
    try {
      throwIfAborted(signal);
      await connect();
      throwIfAborted(signal);
      const projectName =
        opts.projectName || inferProjectName(state && state.activeFile) || listRootProjects(state)[0];
      if (!projectName) {
        return { projectName: "", folderId: null, deletions: [] };
      }
      const folderId = await resolveExistingProjectFolderId(projectName);
      throwIfAborted(signal);
      if (!folderId) {
        return { projectName: projectName, folderId: null, deletions: [] };
      }
      const deletions = await findDriveDeletions(folderId, state, projectName);
      throwIfAborted(signal);
      return { projectName: projectName, folderId: folderId, deletions: deletions };
    } finally {
      if (signal && activeOperationSignal === signal) {
        activeOperationSignal = previousSignal;
      }
    }
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
      ? DRIVE_UPLOAD +
        "/files/" +
        encodeURIComponent(existingId) +
        "?uploadType=multipart&supportsAllDrives=true&fields=id,name"
      : DRIVE_UPLOAD + "/files?uploadType=multipart&supportsAllDrives=true&fields=id,name";

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
    const saved = await response.json();
    if (!existingId && saved && saved.id) {
      await maybeTransferToProjectOwner(saved.id);
    }
    return saved;
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

  async function syncFilesIntoExistingFolder(folderId, state, projectName, options) {
    const opts = options || {};
    const signal = opts.signal;
    const notify = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const name = String(projectName || "").trim();
    const targetId = String(folderId || "").trim();
    if (!name || !targetId) {
      throw new Error("Missing project folder for Google Drive save.");
    }
    if (name.toLowerCase() === String(CLOUD_FOLDER_NAME).toLowerCase()) {
      throw new Error('Project name cannot be "' + CLOUD_FOLDER_NAME + '".');
    }
    // Hard guard: never sync against the Undertwig root (would touch every project).
    let rootId = cachedUndertwigFolderId;
    try {
      rootId = await ensureUndertwigFolder();
    } catch (_error) {
      // Keep cached id if ensure fails mid-save.
    }
    if (rootId && String(rootId) === targetId) {
      removeMappedProject(name);
      throw new Error(
        "Refusing to save into the Undertwig root folder. Re-open the project and try again."
      );
    }
    const relativeFiles = filesForProject(state, name);
    const relativeFolders = foldersForProject(state, name);

    throwIfAborted(signal);

    // Refresh owner email so transfers/deletes work for shared projects.
    try {
      await refreshProjectMeta(targetId);
    } catch (_error) {
      // Continue; ownership helpers will no-op without an owner email.
    }
    throwIfAborted(signal);
    await reclaimSharedOwnershipUnderFolder(targetId);
    throwIfAborted(signal);

    if (opts.deleteMissing) {
      const deletions = await findDriveDeletions(targetId, state, name);
      for (let i = 0; i < deletions.length; i += 1) {
        throwIfAborted(signal);
        await removeDriveItemFromProject(deletions[i]);
      }
    }

    for (let i = 0; i < relativeFolders.length; i += 1) {
      throwIfAborted(signal);
      await ensurePathFolders(targetId, relativeFolders[i]);
    }

    const paths = Object.keys(relativeFiles);
    for (let i = 0; i < paths.length; i += 1) {
      throwIfAborted(signal);
      const relPath = paths[i];
      if (notify) {
        notify(
          "Uploading “" +
            name +
            "” to Google Drive (" +
            (i + 1) +
            "/" +
            paths.length +
            "): " +
            relPath
        );
      }
      const parts = relPath.split("/");
      const fileName = parts.pop();
      const parentId = await ensurePathFolders(targetId, parts.join("/"));
      const existing = await findNamedChild(parentId, fileName, null);
      await uploadFileToFolder(parentId, fileName, relativeFiles[relPath], existing && existing.id);
    }

    writeActiveFolderId(targetId);
    return targetId;
  }

  async function syncOneProject(state, projectName, options) {
    const opts = options || {};
    const name = String(projectName || "").trim();
    if (!name) {
      throw new Error("Missing project name.");
    }
    try {
      const folderId = await ensureProjectFolder(name);
      await syncFilesIntoExistingFolder(folderId, state, name, opts);
      writeRole("owner");
      return folderId;
    } catch (error) {
      const message = (error && error.message) || "";
      if (!/File not found|not found|404/i.test(message)) {
        throw error;
      }
      // Stale cached IDs (often a legacy JSON file) — rebuild Undertwig folders once.
      clearFolderCaches();
      const folderId = await ensureProjectFolder(name);
      await syncFilesIntoExistingFolder(folderId, state, name, opts);
      writeRole("owner");
      return folderId;
    }
  }

  async function saveProject(state, options) {
    const opts = options || {};
    const signal = opts.signal;
    const syncOpts = {
      deleteMissing: Boolean(opts.deleteMissing),
      signal: signal,
      onProgress: opts.onProgress,
    };
    const run = async function () {
      const previousSignal = activeOperationSignal;
      if (signal) {
        activeOperationSignal = signal;
      }
      try {
        throwIfAborted(signal);
        await connect();
        throwIfAborted(signal);
        // Only the Current project folder is synced: Undertwig / <projectName> / …
        const projectName = String(
          opts.projectName || inferProjectName(state.activeFile) || ""
        ).trim();

        // Shared / invited projects always write into the owner's folder.
        if (projectName && isCurrentProjectShared(projectName)) {
          const sharedId = getMappedFolderId(projectName) || getProjectFolderId();
          if (!sharedId) {
            throw new Error("Missing shared project folder. Open the invite link again.");
          }
          const meta = await refreshProjectMeta(sharedId);
          if (!meta) {
            throw new Error("Shared project folder is no longer accessible.");
          }
          setMappedProject(projectName, sharedId, cachedRole || "writer");
          await syncFilesIntoExistingFolder(sharedId, state, projectName, syncOpts);
          return { folderIds: [sharedId], role: cachedRole, projectName: projectName };
        }

        if (isCollaborator() && !projectName) {
          const sharedId = getProjectFolderId();
          if (!sharedId) {
            throw new Error("Missing shared project folder. Open the invite link again.");
          }
          throw new Error("Select a file inside the shared project before saving.");
        }

        if (!projectName) {
          await ensureUndertwigFolder();
          writeRole("owner");
          throw new Error("Set a current project before saving to Google Drive.");
        }

        const folderId = await syncOneProject(state, projectName, syncOpts);
        return {
          folderIds: folderId ? [folderId] : [],
          role: "owner",
          projectName: projectName,
        };
      } finally {
        if (signal && activeOperationSignal === signal) {
          activeOperationSignal = previousSignal;
        }
      }
    };

    saveChain = saveChain.then(run, run);
    return saveChain;
  }

  async function listFolderTree(folderId, prefix, signal) {
    const entries = [];
    const children = await listChildren(folderId, signal);
    for (let i = 0; i < children.length; i += 1) {
      throwIfAborted(signal);
      const child = children[i];
      const path = prefix ? prefix + "/" + child.name : child.name;
      // Hide per-file edit locks from the LaTeX project tree.
      if (!prefix && child.name === LOCK_DIR_NAME) {
        continue;
      }
      if (isLockInfraPath(path)) {
        continue;
      }
      if (child.mimeType === "application/vnd.google-apps.folder") {
        entries.push({
          type: "folder",
          path: path,
          id: child.id,
          parentId: folderId,
          name: child.name,
          owners: child.owners || [],
        });
        const nested = await listFolderTree(child.id, path, signal);
        entries.push.apply(entries, nested);
      } else if (child.mimeType && child.mimeType.indexOf("application/vnd.google-apps.") === 0) {
        // Skip Google Docs/Sheets/etc. — Undertwig stores plain project files.
        continue;
      } else {
        entries.push({
          type: "file",
          path: path,
          id: child.id,
          parentId: folderId,
          name: child.name,
          mimeType: child.mimeType,
          owners: child.owners || [],
        });
      }
    }
    return entries;
  }

  async function downloadDriveFile(fileId, asBinary, signal) {
    const response = await driveFetch(
      DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media&supportsAllDrives=true",
      { method: "GET", signal: signal || undefined }
    );
    throwIfAborted(signal);
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not download Drive file."));
    }
    if (asBinary) {
      const blob = await abortablePromise(response.blob(), signal);
      throwIfAborted(signal);
      return blobToBase64(blob);
    }
    const text = await abortablePromise(response.text(), signal);
    throwIfAborted(signal);
    return text;
  }

  function isBinaryMime(mimeType, path) {
    if (mimeType && mimeType.indexOf("text/") === 0) {
      return false;
    }
    if (
      mimeType === "application/json" ||
      mimeType === "application/xml" ||
      mimeType === "application/javascript" ||
      mimeType === "application/x-tex" ||
      mimeType === "application/x-latex"
    ) {
      return false;
    }
    const name = String(path || "").split("/").pop() || "";
    const dot = name.lastIndexOf(".");
    if (dot <= 0) {
      return false;
    }
    const ext = name.slice(dot + 1).toLowerCase();
    const binaryExts = {
      pdf: 1,
      png: 1,
      jpg: 1,
      jpeg: 1,
      webp: 1,
      bmp: 1,
      tif: 1,
      tiff: 1,
      ico: 1,
      svg: 1,
      gif: 1,
      avif: 1,
      heic: 1,
      heif: 1,
      mp4: 1,
      webm: 1,
      mov: 1,
      zip: 1,
      gz: 1,
      wasm: 1,
      woff: 1,
      woff2: 1,
      ttf: 1,
      otf: 1,
    };
    return Boolean(binaryExts[ext]);
  }

  /**
   * Pull a Drive folder into an Undertwig workspace project (Drive → file tree).
   * Used when an invitee opens an invite link.
   */
  async function loadFolderAsProject(folderId, projectName, onProgress, signal) {
    const notify = typeof onProgress === "function" ? onProgress : function () {};
    throwIfAborted(signal);
    const meta = await refreshProjectMeta(folderId);
    throwIfAborted(signal);
    if (!meta) {
      throw new Error("Could not read the Google Drive project folder.");
    }
    const name = projectName || meta.name || "SharedProject";

    notify("Listing files in Google Drive / " + name + "…");
    const entries = await listFolderTree(folderId, "", signal);
    throwIfAborted(signal);
    const folders = [];
    const files = {};
    const fileEntries = [];

    folders.push(name);
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const fullPath = name + "/" + entry.path;
      if (entry.type === "folder") {
        folders.push(fullPath);
      } else {
        fileEntries.push({ entry: entry, fullPath: fullPath });
      }
    }

    if (!fileEntries.length) {
      const emptyError = new Error(
        "The shared Google Drive folder “" +
          name +
          "” has no downloadable files yet. Ask the owner to open the project in Undertwig and click Save, then reopen this invite link."
      );
      emptyError.code = "shared-folder-empty";
      throw emptyError;
    }

    for (let i = 0; i < fileEntries.length; i += 1) {
      throwIfAborted(signal);
      const item = fileEntries[i];
      notify("Downloading " + (i + 1) + "/" + fileEntries.length + ": " + item.entry.name + "…");
      const binary = isBinaryMime(item.entry.mimeType, item.entry.path);
      try {
        const content = await downloadDriveFile(item.entry.id, binary, signal);
        throwIfAborted(signal);
        files[item.fullPath] = {
          name: item.entry.name,
          content: content,
          binary: binary,
        };
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
        throw new Error(
          "Could not download “" +
            item.entry.name +
            "” from Google Drive: " +
            ((error && error.message) || error)
        );
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
    setMappedProject(name, folderId, cachedRole || null);

    return {
      activeFile: activeFile,
      folders: folders,
      files: files,
      projectName: name,
      currentProject: name,
      role: cachedRole,
      fileCount: Object.keys(files).length,
      folderCount: folders.length,
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
        "?supportsAllDrives=true&fields=id,name,mimeType,owners,capabilities,shared,webViewLink,trashed",
      { method: "GET" }
    );
    if (!response.ok) {
      if (response.status === 404) {
        if (cachedActiveFolderId === id) {
          writeActiveFolderId(null);
        }
        removeMappedFolderId(id);
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
      removeMappedFolderId(id);
      return null;
    }

    const role = roleFromMeta(meta);
    writeRole(role);
    writeOwnerEmail(ownerEmailFromMeta(meta));
    return meta;
  }

  async function joinSharedProject(folderId, onProgress) {
    const id = String(folderId || "").trim();
    if (!id) {
      throw new Error("Missing shared project id.");
    }
    rememberPendingInvite(id);
    await connect();
    let meta = null;
    try {
      // Resolve access before remembering this folder as active — otherwise a failed
      // invite leaves Drive status stuck on an inaccessible id.
      meta = await refreshProjectMeta(id);
    } catch (error) {
      const message = (error && error.message) || "";
      if (isInsufficientScopeMessage(message)) {
        const scopeError = new Error(
          "Undertwig needs Google Drive access to open shared projects. Click Retry to grant access, then reopen the invite link."
        );
        scopeError.code = "missing-scope";
        throw scopeError;
      }
      throw error;
    }
    if (!meta) {
      const accessError = new Error(
        "Could not open the shared project folder. Ask the owner to click Copy invitation link (or Send invite) again so Google Drive grants link access, then reopen this invite."
      );
      accessError.code = "shared-folder-unavailable";
      throw accessError;
    }

    writeActiveFolderId(id);

    // Mark invitee before download so the tree label is correct as soon as files land.
    const role = isOwnerEmail(meta) ? "owner" : "writer";
    writeRole(role);

    const project = await loadFolderAsProject(id, meta.name, onProgress);
    if (!project) {
      throw new Error("Shared project folder was inaccessible.");
    }
    setMappedProject(project.projectName || meta.name, id, role);
    project.role = role;
    project.currentProject = project.projectName || meta.name;
    clearPendingInvite();
    if (role !== "owner") {
      try {
        await rememberInvitedProject(
          id,
          project.projectName || meta.name,
          ownerEmailFromMeta(meta) || cachedOwnerEmail
        );
      } catch (_error) {
        // Listing still works via sharedWithMe / map; registry is best-effort.
      }
    }
    return project;
  }

  /** Explicit Drive → Undertwig sync for a folder id (invite or refresh). */
  async function syncFromDrive(folderId, onProgress) {
    return joinSharedProject(folderId, onProgress);
  }

  /**
   * List project folders under My Drive / Undertwig / (owned cloud projects).
   * @returns {Promise<Array<{id: string, name: string, modifiedTime: string|null}>>}
   */
  async function listUndertwigProjects(options) {
    const opts = options || {};
    await connect({
      interactive: Boolean(opts.interactive),
      forcePrompt: Boolean(opts.forcePrompt),
      allowConsentRetry: Boolean(opts.allowConsentRetry),
    });
    const rootId = await ensureUndertwigFolder();
    const children = await listChildren(rootId);
    const projects = [];
    const listedNames = {};
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child || child.mimeType !== "application/vnd.google-apps.folder" || !child.id) {
        continue;
      }
      const name = String(child.name || "").trim();
      if (!name) {
        continue;
      }
      listedNames[name] = true;
      projects.push({
        id: String(child.id),
        name: name,
        modifiedTime: child.modifiedTime || null,
      });
      // Keep map warm so Save/Load resolve faster.
      const existingRole = getMappedRole(name);
      if (!getMappedFolderId(name) || existingRole === "owner" || !existingRole) {
        setMappedProject(name, child.id, "owner");
      }
    }
    // Drop stale owner maps for folders that no longer exist under Undertwig/.
    Object.keys(projectFolderMap || {}).forEach(function (name) {
      if (listedNames[name]) {
        return;
      }
      if (getMappedRole(name) !== "owner") {
        return;
      }
      const removedId = getMappedFolderId(name);
      removeMappedProject(name);
      if (removedId && cachedActiveFolderId === removedId) {
        writeActiveFolderId(null);
      }
    });
    projects.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    return projects;
  }

  /**
   * Classify a shared folder for Cloud (invited):
   * - "foreign-undertwig": parent is Undertwig not owned by me
   * - "not-undertwig": readable parents exist and none is a foreign Undertwig
   * - "unknown": parents missing or unreadable (typical for link invites)
   */
  async function undertwigInviteStatus(folderMeta, me) {
    const want = String(me || "").toLowerCase();
    const parents = Array.isArray(folderMeta && folderMeta.parents) ? folderMeta.parents : [];
    if (!parents.length) {
      return "unknown";
    }
    let readableParents = 0;
    for (let i = 0; i < parents.length; i += 1) {
      const parentId = String(parents[i] || "").trim();
      if (!parentId) {
        continue;
      }
      const parent = await fetchDriveFileMeta(
        parentId,
        "id,name,mimeType,trashed,owners"
      );
      if (!isDriveFolderMeta(parent)) {
        return "unknown";
      }
      readableParents += 1;
      if (String(parent.name || "").toLowerCase() !== String(CLOUD_FOLDER_NAME).toLowerCase()) {
        continue;
      }
      const parentOwner = ownerEmailFromMeta(parent);
      if (!parentOwner || !want || String(parentOwner).toLowerCase() !== want) {
        return "foreign-undertwig";
      }
    }
    return readableParents > 0 ? "not-undertwig" : "unknown";
  }

  /** True only when a parent folder is named Undertwig and is not owned by me. */
  async function isUnderForeignUndertwig(folderMeta, me) {
    return (await undertwigInviteStatus(folderMeta, me)) === "foreign-undertwig";
  }

  /**
   * List invited project folders shared with the user that live under someone else's Undertwig /
   * (or children of a shared Undertwig root). Mirrors Android DriveSyncRepository.listCloudProjects.
   * @returns {Promise<Array<{id: string, name: string, modifiedTime: string|null, ownerEmail: string|null}>>}
   */
  async function listSharedUndertwigProjects(options) {
    const opts = options || {};
    await connect({
      interactive: Boolean(opts.interactive),
      forcePrompt: Boolean(opts.forcePrompt),
      allowConsentRetry: Boolean(opts.allowConsentRetry),
    });

    const me = currentSessionEmail();
    let rootId = null;
    const ownedIds = {};
    try {
      rootId = await ensureUndertwigFolder();
      const ownedChildren = await listChildren(rootId);
      for (let i = 0; i < ownedChildren.length; i += 1) {
        const child = ownedChildren[i];
        if (child && child.id && child.mimeType === "application/vnd.google-apps.folder") {
          ownedIds[String(child.id)] = true;
        }
      }
    } catch (_error) {
      rootId = null;
    }

    const invited = [];
    const invitedIds = {};
    const shared = await driveSearch(
      "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      100
    );

    for (let i = 0; i < shared.length; i += 1) {
      const child = shared[i];
      if (!child || !child.id) {
        continue;
      }
      const id = String(child.id);
      if (ownedIds[id] || id === rootId || invitedIds[id]) {
        continue;
      }
      const name = String(child.name || "").trim() || "Untitled";
      const owner = ownerEmailFromMeta(child);
      if (me && owner && String(owner).toLowerCase() === me) {
        continue;
      }

      // Whole Undertwig folder shared with us → list its project children.
      if (name.toLowerCase() === String(CLOUD_FOLDER_NAME).toLowerCase()) {
        let projects = [];
        try {
          projects = await listChildren(id);
        } catch (_error) {
          projects = [];
        }
        for (let j = 0; j < projects.length; j += 1) {
          const project = projects[j];
          if (
            !project ||
            !project.id ||
            project.mimeType !== "application/vnd.google-apps.folder"
          ) {
            continue;
          }
          const projectId = String(project.id);
          if (ownedIds[projectId] || invitedIds[projectId]) {
            continue;
          }
          invitedIds[projectId] = true;
          const projectName = String(project.name || "").trim() || "Untitled";
          invited.push({
            id: projectId,
            name: projectName,
            modifiedTime: project.modifiedTime || null,
            ownerEmail: ownerEmailFromMeta(project) || owner || null,
          });
          if (!getMappedFolderId(projectName)) {
            setMappedProject(projectName, projectId, "writer");
          }
        }
        continue;
      }

      // Project folder shared directly → only keep if parent is someone else's Undertwig.
      // Unknown/unreadable parents are NOT listed here (that re-includes every Shared Drive
      // folder). Those invites appear via the Undertwig invite registry after open.
      const meta =
        (await fetchDriveFileMeta(
          id,
          "id,name,mimeType,modifiedTime,owners,parents,trashed"
        )) || child;
      if (!isDriveFolderMeta(meta)) {
        continue;
      }
      if (!(await isUnderForeignUndertwig(meta, me))) {
        continue;
      }
      invitedIds[id] = true;
      invited.push({
        id: id,
        name: name,
        modifiedTime: meta.modifiedTime || child.modifiedTime || null,
        ownerEmail: ownerEmailFromMeta(meta) || owner || null,
      });
      if (!getMappedFolderId(name)) {
        setMappedProject(name, id, "writer");
      }
    }

    // Invites accepted via Undertwig (link/email).
    // Keep unknown parents only for registry entries (opened through Undertwig).
    // Drop confirmed non-Undertwig pollution from older builds.
    const remembered = await listRememberedInvitedProjects(me);
    const cleanRegistry = [];
    for (let r = 0; r < remembered.length; r += 1) {
      const entry = remembered[r];
      if (!entry || !entry.id || ownedIds[entry.id] || entry.id === rootId) {
        continue;
      }
      // Registry entries were accepted through Undertwig; drop only when parents
      // prove the folder is not under a foreign Undertwig.
      if (entry._inviteStatus === "not-undertwig") {
        continue;
      }
      cleanRegistry.push({
        id: entry.id,
        name: entry.name,
        ownerEmail: entry.ownerEmail || "",
        updatedAt: entry.updatedAt || Date.now(),
      });
      if (invitedIds[entry.id]) {
        continue;
      }
      invitedIds[entry.id] = true;
      invited.push({
        id: entry.id,
        name: entry.name,
        modifiedTime: entry.modifiedTime || null,
        ownerEmail: entry.ownerEmail || null,
      });
      if (entry.name && !getMappedFolderId(entry.name)) {
        setMappedProject(entry.name, entry.id, "writer");
      }
    }
    try {
      await writeInvitedRegistry(cleanRegistry);
    } catch (_error) {
      // Best-effort prune of non-Undertwig registry entries.
    }

    // Local invite map → only folders confirmed under a foreign Undertwig.
    // Do not trust "unknown" map entries (older builds mapped every shared folder).
    const mappedInvites = listInvitedProjects();
    const registrySeed = cleanRegistry.slice();
    const registryIds = {};
    cleanRegistry.forEach(function (entry) {
      if (entry && entry.id) {
        registryIds[String(entry.id)] = true;
      }
    });
    for (let m = 0; m < mappedInvites.length; m += 1) {
      const mapped = mappedInvites[m];
      if (!mapped || !mapped.id) {
        continue;
      }
      const mappedId = String(mapped.id);
      if (ownedIds[mappedId] || mappedId === rootId) {
        continue;
      }
      const meta = await fetchDriveFileMeta(
        mappedId,
        "id,name,mimeType,modifiedTime,owners,parents,trashed"
      );
      if (!isDriveFolderMeta(meta)) {
        removeMappedProject(mapped.name);
        continue;
      }
      const status = await undertwigInviteStatus(meta, me);
      if (status === "not-undertwig") {
        removeMappedProject(mapped.name);
        continue;
      }
      if (status !== "foreign-undertwig") {
        // unknown parent: keep only if accepted via Undertwig invite registry;
        // drop stale Shared-with-me pollution from older builds.
        if (!registryIds[mappedId]) {
          removeMappedProject(mapped.name);
          continue;
        }
      }
      if (!invitedIds[mappedId]) {
        invitedIds[mappedId] = true;
        invited.push({
          id: mappedId,
          name: String(meta.name || mapped.name || "").trim() || "Untitled",
          modifiedTime: meta.modifiedTime || null,
          ownerEmail: ownerEmailFromMeta(meta) || null,
        });
      }
      if (status === "foreign-undertwig") {
        registrySeed.push({
          id: mappedId,
          name: String(mapped.name || meta.name || "").trim() || "Untitled",
          ownerEmail: ownerEmailFromMeta(meta) || "",
          updatedAt: Date.now(),
        });
      }
    }
    if (registrySeed.length) {
      try {
        const byId = {};
        registrySeed.forEach(function (entry) {
          if (entry && entry.id) {
            byId[String(entry.id)] = entry;
          }
        });
        await writeInvitedRegistry(
          Object.keys(byId).map(function (key) {
            return byId[key];
          })
        );
      } catch (_error) {
        // Best-effort sync for Android.
      }
    }

    invited.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    return invited;
  }

  // Shared across web + Android (full Drive scope). appDataFolder is per OAuth client
  // and cannot sync invites from desktop to the phone.
  const INVITED_REGISTRY_NAME = ".undertwig-invited-projects-v1.json";
  const LEGACY_APPDATA_REGISTRY_NAME = "undertwig-invited-projects-v1.json";

  async function findAppDataFileId(fileName) {
    const response = await driveFetch(
      DRIVE_API +
        "/files?spaces=appDataFolder&pageSize=10&fields=files(id,name)&q=" +
        encodeURIComponent("name = '" + String(fileName || "").replace(/'/g, "\\'") + "' and trashed = false"),
      { method: "GET" }
    );
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    const files = (payload && payload.files) || [];
    for (let i = 0; i < files.length; i += 1) {
      if (files[i] && files[i].name === fileName && files[i].id) {
        return String(files[i].id);
      }
    }
    return null;
  }

  async function findUndertwigRegistryFileId() {
    try {
      const rootId = await ensureUndertwigFolder();
      const existing = await findNamedChild(rootId, INVITED_REGISTRY_NAME, null);
      return existing && existing.id ? String(existing.id) : null;
    } catch (_error) {
      return null;
    }
  }

  async function parseRegistryPayload(payload) {
    if (!payload) {
      return [];
    }
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (_error) {
        return [];
      }
    }
    return Array.isArray(payload.projects) ? payload.projects : [];
  }

  async function readLegacyAppDataRegistry() {
    const fileId = await findAppDataFileId(LEGACY_APPDATA_REGISTRY_NAME);
    if (!fileId) {
      return [];
    }
    try {
      const response = await driveFetch(
        DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media&spaces=appDataFolder",
        { method: "GET" }
      );
      if (!response.ok) {
        return [];
      }
      return parseRegistryPayload(await response.json());
    } catch (_error) {
      return [];
    }
  }

  async function readInvitedRegistry() {
    try {
      const fileId = await findUndertwigRegistryFileId();
      if (fileId) {
        const response = await driveFetch(
          DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media&supportsAllDrives=true",
          { method: "GET" }
        );
        if (response.ok) {
          const projects = await parseRegistryPayload(await response.json());
          if (projects.length) {
            return projects;
          }
        }
      }
    } catch (_error) {
      // Fall through to legacy appData.
    }
    const legacy = await readLegacyAppDataRegistry();
    if (legacy.length) {
      // One-time migrate so Android (different OAuth client) can see desktop invites.
      try {
        await writeInvitedRegistry(legacy);
      } catch (_error) {
        // Best-effort.
      }
    }
    return legacy;
  }

  async function writeInvitedRegistry(projects) {
    const body = JSON.stringify({ projects: projects || [] });
    const rootId = await ensureUndertwigFolder();
    const existingId = await findUndertwigRegistryFileId();
    const metadata = {
      name: INVITED_REGISTRY_NAME,
      mimeType: "application/json",
    };
    if (!existingId) {
      metadata.parents = [rootId];
    }
    const boundary = "undertwig_" + Date.now();
    const multipart =
      "--" +
      boundary +
      "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) +
      "\r\n--" +
      boundary +
      "\r\nContent-Type: application/json\r\n\r\n" +
      body +
      "\r\n--" +
      boundary +
      "--\r\n";
    const url = existingId
      ? DRIVE_UPLOAD +
        "/files/" +
        encodeURIComponent(existingId) +
        "?uploadType=multipart&supportsAllDrives=true&fields=id"
      : DRIVE_UPLOAD + "/files?uploadType=multipart&supportsAllDrives=true&fields=id";
    const response = await driveFetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: {
        "Content-Type": "multipart/related; boundary=" + boundary,
      },
      body: multipart,
    });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not save invited project list."));
    }
  }

  /** Remember an accepted invite in Drive/Undertwig so Android home can list it after refresh. */
  async function rememberInvitedProject(folderId, projectName, ownerEmail) {
    const id = String(folderId || "").trim();
    if (!id) {
      return;
    }
    await connect();
    const projects = (await readInvitedRegistry()).filter(function (entry) {
      return entry && String(entry.id || "") !== id;
    });
    projects.unshift({
      id: id,
      name: String(projectName || "").trim() || "Untitled",
      ownerEmail: String(ownerEmail || "").trim() || "",
      updatedAt: Date.now(),
    });
    while (projects.length > 50) {
      projects.pop();
    }
    await writeInvitedRegistry(projects);
  }

  async function listRememberedInvitedProjects(userEmail) {
    const me = String(userEmail || currentSessionEmail() || "").toLowerCase();
    const entries = await readInvitedRegistry();
    const out = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const id = entry && String(entry.id || "").trim();
      if (!id) {
        continue;
      }
      const meta = await fetchDriveFileMeta(
        id,
        "id,name,mimeType,modifiedTime,owners,parents,trashed"
      );
      if (!isDriveFolderMeta(meta)) {
        continue;
      }
      const status = await undertwigInviteStatus(meta, me);
      out.push({
        id: id,
        name: String(meta.name || entry.name || "").trim() || "Untitled",
        modifiedTime: meta.modifiedTime || null,
        ownerEmail: ownerEmailFromMeta(meta) || entry.ownerEmail || null,
        updatedAt: entry.updatedAt || Date.now(),
        _inviteStatus: status,
      });
    }
    return out;
  }

  /**
   * Resolve the Drive folder id for a local project name (owner Undertwig child or shared map).
   */
  async function resolveProjectDriveFolderId(projectName, signal) {
    const name = String(projectName || "").trim();
    if (!name) {
      return null;
    }
    throwIfAborted(signal);
    let folderId = getMappedFolderId(name) || null;
    if (!folderId && isCurrentProjectShared(name) && getProjectFolderId()) {
      folderId = getProjectFolderId();
    }
    if (!folderId && isCollaborator() && getProjectFolderId()) {
      const meta = await refreshProjectMeta(getProjectFolderId());
      throwIfAborted(signal);
      if (meta && (meta.name === name || !getMappedFolderId(name))) {
        folderId = getProjectFolderId();
      }
    }
    if (!folderId) {
      try {
        const rootId = await ensureUndertwigFolder();
        throwIfAborted(signal);
        const children = await listChildren(rootId, signal);
        throwIfAborted(signal);
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          if (
            child &&
            child.mimeType === "application/vnd.google-apps.folder" &&
            child.name === name
          ) {
            folderId = child.id;
            setMappedProject(name, folderId, "owner");
            break;
          }
        }
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw error;
        }
      }
    }
    return folderId || null;
  }

  /**
   * Pull the named project's Google Drive folder into an Undertwig project snapshot.
   * Used by the file-tree Sync button (Drive → local tree).
   */
  async function pullProjectFromDrive(projectName, onProgressOrOptions) {
    let onProgress = null;
    let signal = null;
    if (typeof onProgressOrOptions === "function") {
      onProgress = onProgressOrOptions;
    } else if (onProgressOrOptions && typeof onProgressOrOptions === "object") {
      onProgress = onProgressOrOptions.onProgress || null;
      signal = onProgressOrOptions.signal || null;
    }

    const name = String(projectName || "").trim();
    if (!name) {
      throw new Error("Set a current project in the file tree before syncing.");
    }

    const previousSignal = activeOperationSignal;
    if (signal) {
      activeOperationSignal = signal;
    }
    try {
      throwIfAborted(signal);
      await abortablePromise(connect(), signal);
      throwIfAborted(signal);

      const folderId = await resolveProjectDriveFolderId(name, signal);
      if (!folderId) {
        throw new Error(
          "No Google Drive folder found for “" +
            name +
            "”. Save the project first, or open it from an invite link."
        );
      }

      return await loadFolderAsProject(folderId, name, onProgress, signal);
    } finally {
      if (signal && activeOperationSignal === signal) {
        activeOperationSignal = previousSignal;
      }
    }
  }

  /**
   * Download one file from Drive into a workspace file entry (Drive → local).
   * @returns {Promise<{path: string, name: string, content: string, binary: boolean}>}
   */
  async function pullFileFromDrive(projectName, filePath, onProgressOrOptions) {
    let onProgress = null;
    let signal = null;
    if (typeof onProgressOrOptions === "function") {
      onProgress = onProgressOrOptions;
    } else if (onProgressOrOptions && typeof onProgressOrOptions === "object") {
      onProgress = onProgressOrOptions.onProgress || null;
      signal = onProgressOrOptions.signal || null;
    }
    const notify = typeof onProgress === "function" ? onProgress : function () {};

    const name = String(projectName || "").trim();
    const fullPath = String(filePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!name) {
      throw new Error("Set a current project before loading a file from Drive.");
    }
    if (!fullPath) {
      throw new Error("Choose a file to load from Google Drive.");
    }

    let relative = projectRelativePath(name, fullPath);
    if (relative === null) {
      // Allow project-relative paths without the project prefix.
      relative = fullPath.indexOf(name + "/") === 0 ? fullPath.slice(name.length + 1) : fullPath;
    }
    if (!relative) {
      throw new Error("Choose a file inside the project to load from Google Drive.");
    }

    const previousSignal = activeOperationSignal;
    if (signal) {
      activeOperationSignal = signal;
    }
    try {
      throwIfAborted(signal);
      await abortablePromise(connect(), signal);
      throwIfAborted(signal);

      const folderId = await resolveProjectDriveFolderId(name, signal);
      if (!folderId) {
        throw new Error(
          "No Google Drive folder found for “" +
            name +
            "”. Save the project first, or open it from an invite link."
        );
      }

      notify("Finding “" + relative + "” on Google Drive…");
      const parts = relative.split("/").filter(Boolean);
      const fileName = parts.pop();
      let parentId = folderId;
      for (let i = 0; i < parts.length; i += 1) {
        throwIfAborted(signal);
        const child = await findNamedChild(
          parentId,
          parts[i],
          "application/vnd.google-apps.folder"
        );
        if (!child || !child.id) {
          throw new Error(
            "Google Drive folder “" + parts.slice(0, i + 1).join("/") + "” was not found in “" + name + "”."
          );
        }
        parentId = child.id;
      }
      throwIfAborted(signal);
      const remote = await findNamedChild(parentId, fileName, null);
      if (
        !remote ||
        !remote.id ||
        remote.mimeType === "application/vnd.google-apps.folder"
      ) {
        throw new Error(
          "“" + relative + "” was not found in Google Drive / Undertwig / " + name + "."
        );
      }
      if (
        remote.mimeType &&
        remote.mimeType.indexOf("application/vnd.google-apps.") === 0
      ) {
        throw new Error("“" + relative + "” is a Google Doc-type file and cannot be loaded into Undertwig.");
      }

      notify("Downloading “" + relative + "” from Google Drive…");
      const binary = isBinaryMime(remote.mimeType, relative);
      const content = await downloadDriveFile(remote.id, binary, signal);
      throwIfAborted(signal);

      writeActiveFolderId(folderId);
      return {
        path: name + "/" + relative,
        name: fileName,
        content: content,
        binary: binary,
      };
    } finally {
      if (signal && activeOperationSignal === signal) {
        activeOperationSignal = previousSignal;
      }
    }
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
      removeMappedProject(name);
      folderId = await ensureProjectFolder(name);
      meta = await refreshProjectMeta(folderId);
    }
    if (!meta || meta.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("Could not resolve a Drive folder to share for this project.");
    }
    if (isCurrentProjectShared(name) || (cachedRole && cachedRole !== "owner")) {
      throw new Error("Only the project owner can invite collaborators.");
    }

    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(folderId) +
        "/permissions?sendNotificationEmail=true&supportsAllDrives=true&fields=id,role,emailAddress",
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

  /**
   * Grant "anyone with the link" access so Copy invitation link works without a prior email share.
   * Email invites still add a per-user permission; this makes the URL itself usable.
   */
  async function ensureInviteLinkAccess(folderId, role) {
    const id = String(folderId || "").trim();
    if (!id) {
      throw new Error("Missing project folder.");
    }
    await connect();
    const wantRole = role || "writer";

    const listResponse = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(id) +
        "/permissions?supportsAllDrives=true&fields=permissions(id,type,role)",
      { method: "GET" }
    );
    if (listResponse.ok) {
      const payload = await listResponse.json();
      const permissions = (payload && payload.permissions) || [];
      for (let i = 0; i < permissions.length; i += 1) {
        const permission = permissions[i];
        if (!permission || permission.type !== "anyone") {
          continue;
        }
        if (
          permission.role === "writer" ||
          permission.role === "owner" ||
          (wantRole === "reader" && permission.role === "reader")
        ) {
          return { folderId: id, alreadyShared: true, role: permission.role };
        }
      }
    }

    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(id) +
        "/permissions?supportsAllDrives=true&fields=id,type,role",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "anyone",
          role: wantRole,
          allowFileDiscovery: false,
        }),
      }
    );
    if (!response.ok) {
      const detail = await readDriveError(
        response,
        "Could not create a shareable invitation link for this project."
      );
      if (/already|exists/i.test(detail)) {
        return { folderId: id, alreadyShared: true, role: wantRole };
      }
      throw new Error(detail);
    }
    return { folderId: id, alreadyShared: false, role: wantRole };
  }

  async function probeConnection() {
    if (!isAvailable()) {
      return { connected: false, fileId: null, role: null, reason: "not-signed-in" };
    }
    try {
      await connect();
      const activeId = getProjectFolderId();
      if (activeId) {
        try {
          const meta = await refreshProjectMeta(activeId);
          if (meta) {
            return { connected: true, fileId: activeId, role: cachedRole, reason: "ok" };
          }
        } catch (_metaError) {
          // Inaccessible / stale active folder (failed invite, revoked share) — keep probing.
          if (cachedActiveFolderId === activeId) {
            writeActiveFolderId(null);
          }
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
      if (/File not found|not found|404|insufficientPermissions|403/i.test(message)) {
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

    const projectName =
      opts.projectName || inferProjectName(localState.activeFile) || listRootProjects(localState)[0];

    if (projectName && isCurrentProjectShared(projectName)) {
      await saveProject(localState, { projectName: projectName });
      return {
        project: localState,
        source: "uploaded",
        role: cachedRole,
        folderId: getMappedFolderId(projectName) || getProjectFolderId(),
      };
    }

    if (isCollaborator() && getProjectFolderId()) {
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

    // Owner path: ensure Undertwig/<current project>/ exists and upload that project only.
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
    const activeProject = String(
      projectName || listRootProjects(localState)[0] || ""
    ).trim();
    if (!activeProject) {
      writeRole("owner");
      return { project: localState, source: "uploaded", role: "owner" };
    }
    const folderId = await syncOneProject(localState, activeProject);

    return {
      project: localState,
      source: "uploaded",
      role: "owner",
      folderId: folderId || getProjectFolderId(),
      projectName: activeProject,
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
   * Return a Drive UI URL for the current project folder.
   * For invited/shared projects this is always the owner's folder — never the invitee's Undertwig root.
   */
  async function getOpenInDriveUrl(preferredId, options) {
    await connect();
    const projectName = String((options && options.projectName) || "").trim();
    const shared = projectName ? isCurrentProjectShared(projectName) : isCollaborator();
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
    if (projectName) {
      push(getMappedFolderId(projectName));
    }
    push(getProjectFolderId());

    for (let i = 0; i < candidates.length; i += 1) {
      const meta = await fetchDriveFileMeta(
        candidates[i],
        "id,name,mimeType,trashed,webViewLink,owners,capabilities"
      );
      if (isDriveFolderMeta(meta)) {
        const role = roleFromMeta(meta);
        // Never attach a shared folder ID to the wrong local project name (e.g. SampleProject).
        const mappedIdForName = projectName ? getMappedFolderId(projectName) : null;
        const mapName =
          projectName && (mappedIdForName === meta.id || !mappedIdForName)
            ? role === "owner"
              ? projectName
              : meta.name || projectName
            : meta.name || projectName;
        if (mapName) {
          const existingRole = getMappedRole(mapName);
          const nextRole = isSharedProjectRole(existingRole) ? existingRole : role;
          setMappedProject(mapName, meta.id, nextRole);
          writeRole(nextRole);
        } else {
          writeRole(role);
        }
        writeActiveFolderId(meta.id);
        if (meta.webViewLink) {
          return meta.webViewLink;
        }
        return "https://drive.google.com/drive/folders/" + encodeURIComponent(meta.id);
      }
    }

    // Invitees must never create Undertwig/<project> on their own Drive.
    if (shared) {
      const fallbackId = getMappedFolderId(projectName) || getProjectFolderId() || preferredId;
      if (fallbackId) {
        return "https://drive.google.com/drive/folders/" + encodeURIComponent(fallbackId);
      }
      return "https://drive.google.com/drive/shared-with-me";
    }

    if (projectName) {
      try {
        const ensuredId = await ensureProjectFolder(projectName);
        push(ensuredId);
        const meta = await fetchDriveFileMeta(
          ensuredId,
          "id,name,mimeType,trashed,webViewLink"
        );
        if (isDriveFolderMeta(meta)) {
          if (meta.webViewLink) {
            return meta.webViewLink;
          }
          return "https://drive.google.com/drive/folders/" + encodeURIComponent(meta.id);
        }
      } catch (_error) {
        // Prefer mapped id over opening the Undertwig root.
      }
      const mappedOnly = getMappedFolderId(projectName);
      if (mappedOnly) {
        return "https://drive.google.com/drive/folders/" + encodeURIComponent(mappedOnly);
      }
      // Do not open Undertwig root as a stand-in for the work-desk project.
      return "https://drive.google.com/drive/my-drive";
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

  function setActiveProjectByName(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      return null;
    }
    const id = getMappedFolderId(name);
    if (id) {
      writeActiveFolderId(id);
      const role = getMappedRole(name);
      if (role) {
        writeRole(role);
      }
    }
    return id;
  }

  async function resolveProjectAccess(projectName) {
    const name = String(projectName || "").trim();
    const id = (name && getMappedFolderId(name)) || getProjectFolderId();
    if (!id) {
      writeRole(cachedRole || "owner");
      return { role: cachedRole || "owner", folderId: null };
    }
    const meta = await refreshProjectMeta(id);
    if (!meta) {
      return { role: null, folderId: null };
    }
    const role = cachedRole || roleFromMeta(meta);
    if (name) {
      setMappedProject(name, id, role);
    } else if (meta.name) {
      setMappedProject(meta.name, id, role);
    }
    writeActiveFolderId(id);
    return { role: role, folderId: id, webViewLink: meta.webViewLink || null };
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
   * Confirm the stored token can use My Drive (drive.file), not only openid / appdata.
   * Uses Drive files.list — always settles within 5 seconds.
   */
  async function verifyDriveAccess() {
    if (!hydrateTokenFromStorage()) {
      return { ok: false, reason: "no-token", fileId: null };
    }

    const token = memoryAccessToken;
    const fileId = getProjectFolderId() || cachedUndertwigFolderId || null;

    try {
      // spaces=drive requires drive.file (or broader). drive.appdata-only tokens fail here
      // even though /about may succeed — that was the false "Connected" bug.
      const response = await Promise.race([
        fetch(DRIVE_API + "/files?pageSize=1&spaces=drive&fields=files(id)", {
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

      if (response.status === 401) {
        forgetAccessToken();
        return { ok: false, reason: "unauthorized", fileId: null };
      }
      if (response.status === 403) {
        const detail = await readDriveError(response, "Google Drive permission denied.");
        forgetAccessToken();
        return {
          ok: false,
          reason: isInsufficientScopeMessage(detail) ? "missing-scope" : "unauthorized",
          fileId: null,
        };
      }
      if (!response.ok) {
        return { ok: false, reason: "http-" + response.status, fileId: null };
      }

      if (!memoryTokenScope || !scopeIncludesDriveAccess(memoryTokenScope)) {
        memoryTokenScope = DRIVE_SCOPE;
        writeStoredToken(memoryAccessToken, memoryTokenExpiresAt, memoryTokenScope);
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

  function listInvitedProjects() {
    const out = [];
    Object.keys(projectFolderMap || {}).forEach(function (name) {
      const role = getMappedRole(name);
      if (!isSharedProjectRole(role)) {
        return;
      }
      const id = getMappedFolderId(name);
      if (!id) {
        return;
      }
      out.push({
        name: name,
        id: id,
        role: role,
      });
    });
    out.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  function isAvailable() {
    return Boolean(auth() && auth().isLoggedIn() && auth().getConfig().googleClientId);
  }

  // Startup
  clearLegacyIds();
  function isLockInfraPath(path) {
    const p = String(path || "").replace(/^\/+/, "");
    return p === LOCK_DIR_NAME || p.indexOf(LOCK_DIR_NAME + "/") === 0;
  }

  function getDeviceId() {
    try {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (id && String(id).trim()) {
        return String(id).trim();
      }
      id =
        "web-" +
        Math.random().toString(36).slice(2, 10) +
        "-" +
        Date.now().toString(36);
      localStorage.setItem(DEVICE_ID_KEY, id);
      return id;
    } catch (_error) {
      return "web-ephemeral";
    }
  }

  function lockHolderLabel(lock) {
    if (!lock) {
      return "Someone";
    }
    const name = String(lock.holderName || "").trim();
    const email = String(lock.holderEmail || "").trim();
    if (name && email) {
      return name + " (" + email + ")";
    }
    return name || email || "Someone";
  }

  function isLockStale(lock) {
    if (!lock || !lock.heartbeat) {
      return true;
    }
    const ms = Date.parse(lock.heartbeat);
    if (!Number.isFinite(ms)) {
      return true;
    }
    return Date.now() - ms > LOCK_HEARTBEAT_STALE_MS;
  }

  function isLockHeldByMe(lock) {
    if (!lock) {
      return false;
    }
    const device = getDeviceId();
    if (lock.deviceId && lock.deviceId === device) {
      return true;
    }
    // Same Google account may reclaim (phone vs laptop / cleared site data).
    // Different people are still exclusive via holderEmail mismatch.
    const me = currentSessionEmail();
    if (me && lock.holderEmail && String(lock.holderEmail).toLowerCase() === me) {
      return true;
    }
    return false;
  }

  function projectLockRelPath() {
    return LOCK_DIR_NAME + "/" + PROJECT_LOCK_FILE;
  }

  function buildLockPayload(previous) {
    const session = auth().readSession && auth().readSession();
    const now = new Date().toISOString();
    return {
      version: 2,
      scope: "project",
      path: ".",
      holderEmail: (session && session.email) || currentSessionEmail() || null,
      holderName: (session && session.name) || null,
      deviceId: getDeviceId(),
      since: (previous && previous.since) || now,
      heartbeat: now,
    };
  }

  async function resolveProjectFolderForLocks(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      return null;
    }
    await connect();
    return resolveExistingProjectFolderId(name);
  }

  async function readFileLock(projectName) {
    const folderId = await resolveProjectFolderForLocks(projectName);
    if (!folderId) {
      return null;
    }
    const lockRel = projectLockRelPath();
    const parts = lockRel.split("/");
    const fileName = parts.pop();
    let parentId = folderId;
    for (let i = 0; i < parts.length; i += 1) {
      const child = await findNamedChild(
        parentId,
        parts[i],
        "application/vnd.google-apps.folder"
      );
      if (!child || !child.id) {
        return null;
      }
      parentId = child.id;
    }
    const remote = await findNamedChild(parentId, fileName, null);
    if (!remote || !remote.id || remote.mimeType === "application/vnd.google-apps.folder") {
      return null;
    }
    try {
      const text = await downloadDriveFile(remote.id, false);
      const data = JSON.parse(text);
      if (!data || typeof data !== "object") {
        return null;
      }
      data._fileId = remote.id;
      data._parentId = parentId;
      return data;
    } catch (_error) {
      return null;
    }
  }

  async function writeFileLock(projectName, payload) {
    const folderId = await resolveProjectFolderForLocks(projectName);
    if (!folderId) {
      throw new Error("Project is not linked to Google Drive yet. Save once first.");
    }
    const lockRel = projectLockRelPath();
    const parts = lockRel.split("/");
    const fileName = parts.pop();
    const parentId = await ensurePathFolders(folderId, parts.join("/"));
    const existing = await findNamedChild(parentId, fileName, null);
    const entry = {
      content: JSON.stringify(payload, null, 2),
      binary: false,
    };
    return uploadFileToFolder(
      parentId,
      fileName,
      entry,
      existing && existing.id
    );
  }

  /**
   * Exclusive writing-room lock for an entire project (not per-file).
   * @returns {Promise<{ok:true,lock:object}|{ok:false,lock:object|null,message:string}>}
   */
  async function acquireFileLock(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      return { ok: false, lock: null, message: "Choose a project first." };
    }
    const existing = await readFileLock(name);
    if (existing && !isLockStale(existing) && !isLockHeldByMe(existing)) {
      return {
        ok: false,
        lock: existing,
        message:
          lockHolderLabel(existing) +
          " is currently in the writing room. The writing room has space for one person only at the time.",
      };
    }
    const payload = buildLockPayload(isLockHeldByMe(existing) ? existing : null);
    const saved = await writeFileLock(name, payload);
    const again = await readFileLock(name);
    if (again && !isLockHeldByMe(again) && !isLockStale(again)) {
      return {
        ok: false,
        lock: again,
        message:
          lockHolderLabel(again) +
          " is currently in the writing room. The writing room has space for one person only at the time.",
      };
    }
    const lock = again || Object.assign({}, payload, {
      _fileId: saved && saved.id,
    });
    if (lock && !lock._fileId && saved && saved.id) {
      lock._fileId = saved.id;
    }
    return { ok: true, lock: lock };
  }

  async function heartbeatFileLock(projectName) {
    const name = String(projectName || "").trim();
    if (!name) {
      return { ok: false, lock: null, message: "Missing project." };
    }
    const existing = await readFileLock(name);
    if (!existing) {
      return acquireFileLock(name);
    }
    if (!isLockHeldByMe(existing)) {
      if (!isLockStale(existing)) {
        return {
          ok: false,
          lock: existing,
          message:
            lockHolderLabel(existing) +
            " is currently in the writing room. The writing room has space for one person only at the time.",
        };
      }
      return acquireFileLock(name);
    }
    const payload = buildLockPayload(existing);
    await writeFileLock(name, payload);
    return { ok: true, lock: payload };
  }

  async function releaseFileLock(projectName, _ignoredFileRelPath, options) {
    const opts = options || {};
    const name = String(projectName || "").trim();
    if (!name && !opts.fileId) {
      return false;
    }

    if (opts.keepalive && opts.fileId) {
      trashDriveFileKeepaliveSync(opts.fileId);
      return true;
    }

    let existing = null;
    if (name) {
      existing = await readFileLock(name);
      if (!existing && !opts.fileId) {
        return true;
      }
      if (existing && !isLockHeldByMe(existing) && !isLockStale(existing)) {
        return false;
      }
    }
    const fileId = (existing && existing._fileId) || opts.fileId;
    if (!fileId) {
      return false;
    }
    try {
      await removeDriveItemFromProject({
        id: fileId,
        parentId: (existing && existing._parentId) || null,
        owners: [],
      });
      return true;
    } catch (_error) {
      try {
        await tryTrashDriveFile(fileId, { keepalive: Boolean(opts.keepalive) });
        return true;
      } catch (_error2) {
        if (opts.keepalive) {
          trashDriveFileKeepaliveSync(fileId);
        }
        return false;
      }
    }
  }

  loadProjectMap();
  cachedActiveFolderId = readActiveFolderId();
  cachedRole = readRole();
  cachedOwnerEmail = readOwnerEmail();
  try {
    cachedUndertwigFolderId = localStorage.getItem(UNDERTWIG_FOLDER_KEY) || null;
  } catch (_error) {
    cachedUndertwigFolderId = null;
  }
  hydrateTokenFromStorage();

  global.UndertwigCloud = {
    DRIVE_SCOPE,
    CLOUD_FOLDER_NAME,
    LOCK_DIR_NAME,
    LOCK_HEARTBEAT_STALE_MS,
    isAvailable,
    hasAccessToken,
    verifyDriveAccess,
    isCollaborator,
    isCurrentProjectShared,
    isSharedProjectRole,
    getMappedRole,
    getMappedFolderId,
    listInvitedProjects,
    connect,
    getAccessToken,
    acceptTokenResponse,
    getProjectFileId,
    getOpenInDriveUrl,
    getProjectFolderId,
    getProjectRole,
    getProjectOwnerEmail,
    setActiveProjectFileId,
    setActiveProjectByName,
    resolveProjectAccess,
    buildProjectInvitePath,
    rememberPendingInvite,
    readPendingInvite,
    clearPendingInvite,
    inviteEditorPath,
    joinSharedProject,
    syncFromDrive,
    pullProjectFromDrive,
    pullFileFromDrive,
    listUndertwigProjects,
    listSharedUndertwigProjects,
    shareProjectWithEmail,
    ensureInviteLinkAccess,
    ensureProjectFolder,
    rememberInvitedProject,
    refreshProjectMeta,
    probeConnection,
    previewSaveDeletions,
    syncProject,
    saveProject,
    listRootProjects,
    inferProjectName,
    clearToken,
    clearFolderCaches,
    clearCollaboratorState,
    isLockInfraPath,
    lockHolderLabel,
    isLockStale,
    isLockHeldByMe,
    readFileLock,
    acquireFileLock,
    heartbeatFileLock,
    releaseFileLock,
    getDeviceId,
  };
})(window);
