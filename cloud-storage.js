(function (global) {
  const CLOUD_FILE_NAME = "undertwig-project-v1.json";
  const CLOUD_FOLDER_NAME = "Undertwig";
  // Shareable Drive files (not appData). Required so invitees can work in the owner's project.
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const TOKEN_STORAGE_KEY = "undertwig-drive-token-v1";
  const FILE_ID_STORAGE_KEY = "undertwig-drive-file-v1";
  const FOLDER_ID_STORAGE_KEY = "undertwig-drive-folder-v1";
  const TOKEN_REQUEST_TIMEOUT_MS = 8000;
  const SILENT_TOKEN_TIMEOUT_MS = 4000;
  const INTERACTIVE_TOKEN_TIMEOUT_MS = 120000;
  const FETCH_TIMEOUT_MS = 12000;

  let memoryAccessToken = null;
  let memoryTokenExpiresAt = 0;
  let cachedFileId = null;
  let cachedFolderId = null;
  let cachedRole = null; // "owner" | "writer" | "reader" | null
  let saveChain = Promise.resolve();

  function auth() {
    return global.UndertwigAuth;
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
        JSON.stringify({
          accessToken: accessToken,
          expiresAt: expiresAt,
        })
      );
    } catch (_error) {
      // Ignore.
    }
  }

  function readStoredFileId() {
    try {
      return localStorage.getItem(FILE_ID_STORAGE_KEY) || sessionStorage.getItem(FILE_ID_STORAGE_KEY) || null;
    } catch (_error) {
      return null;
    }
  }

  function writeStoredFileId(fileId) {
    try {
      if (fileId) {
        localStorage.setItem(FILE_ID_STORAGE_KEY, String(fileId));
        sessionStorage.setItem(FILE_ID_STORAGE_KEY, String(fileId));
      } else {
        localStorage.removeItem(FILE_ID_STORAGE_KEY);
        sessionStorage.removeItem(FILE_ID_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore.
    }
  }

  function readStoredFolderId() {
    try {
      return localStorage.getItem(FOLDER_ID_STORAGE_KEY) || null;
    } catch (_error) {
      return null;
    }
  }

  function writeStoredFolderId(folderId) {
    try {
      if (folderId) {
        localStorage.setItem(FOLDER_ID_STORAGE_KEY, String(folderId));
      } else {
        localStorage.removeItem(FOLDER_ID_STORAGE_KEY);
      }
    } catch (_error) {
      // Ignore.
    }
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
        // Best-effort token revoke.
      }
    }
    forgetAccessToken();
    cachedRole = null;
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
    if (!cachedFileId) {
      cachedFileId = readStoredFileId();
    }
    return true;
  }

  function rememberToken(tokenResponse) {
    memoryAccessToken = tokenResponse.access_token;
    const expiresIn = Number(tokenResponse.expires_in) || 3600;
    memoryTokenExpiresAt = Date.now() + expiresIn * 1000;
    writeStoredToken(memoryAccessToken, memoryTokenExpiresAt);
    return memoryAccessToken;
  }

  function withTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message || "Google Cloud request timed out."));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
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

    await ensureGisOauth();

    const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : TOKEN_REQUEST_TIMEOUT_MS;
    const prompt = forcePrompt ? "consent" : "";

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
              ? "Google Cloud authorization timed out while waiting for the permission popup. In Brave, also check Shields for this site, then click Connect again and finish the Google dialog."
              : "Google Cloud authorization needs a permission popup. Click Connect under the file tree."
          )
        );
      }, waitMs);

      try {
        const client = global.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          prompt: prompt,
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
            finish(
              reject,
              new Error((error && error.message) || "Google cloud storage authorization failed.")
            );
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
    const allowConsentRetry = Boolean(options && options.allowConsentRetry);
    const interactive = Boolean(options && options.interactive);
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
        timeoutMs ||
          (forcePrompt || interactive ? INTERACTIVE_TOKEN_TIMEOUT_MS : SILENT_TOKEN_TIMEOUT_MS)
      );
    } catch (error) {
      if (interactive && !forcePrompt) {
        return requestOauthToken(true, INTERACTIVE_TOKEN_TIMEOUT_MS);
      }
      if (!forcePrompt && allowConsentRetry) {
        return requestOauthToken(true, INTERACTIVE_TOKEN_TIMEOUT_MS);
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

  function describeOauthError(response) {
    if (response.error === "access_denied") {
      return "Google Cloud storage permission was denied.";
    }
    if (response.error === "popup_closed_by_user") {
      return "Google Cloud storage permission popup was closed.";
    }
    return response.error_description || response.error || "Google Cloud storage authorization failed.";
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
        Object.assign({}, init, {
          headers,
          credentials: "omit",
          signal: signal,
        })
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
      "/files?fields=files(id,name,modifiedTime,owners,capabilities)&q=" +
      encodeURIComponent(query) +
      "&pageSize=" +
      (pageSize || 1) +
      "&spaces=drive";
    const response = await driveFetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not search Google Drive."));
    }
    const payload = await response.json();
    return (payload && payload.files) || [];
  }

  async function ensureUndertwigFolder() {
    if (cachedFolderId) {
      return cachedFolderId;
    }
    const stored = readStoredFolderId();
    if (stored) {
      cachedFolderId = stored;
      return cachedFolderId;
    }

    const existing = await driveSearch(
      "name = '" +
        CLOUD_FOLDER_NAME +
        "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      1
    );
    if (existing[0] && existing[0].id) {
      cachedFolderId = existing[0].id;
      writeStoredFolderId(cachedFolderId);
      return cachedFolderId;
    }

    const response = await driveFetch(DRIVE_API + "/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: CLOUD_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not create Undertwig Drive folder."));
    }
    const payload = await response.json();
    cachedFolderId = payload.id;
    writeStoredFolderId(cachedFolderId);
    return cachedFolderId;
  }

  function setActiveProjectFileId(fileId) {
    cachedFileId = fileId || null;
    cachedRole = null;
    writeStoredFileId(cachedFileId);
  }

  function getProjectFileId() {
    return cachedFileId || readStoredFileId() || null;
  }

  function getProjectRole() {
    return cachedRole;
  }

  async function refreshProjectMeta(fileId) {
    const id = fileId || getProjectFileId();
    if (!id) {
      cachedRole = null;
      return null;
    }
    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(id) +
        "?fields=id,name,owners,capabilities,shared,webViewLink",
      { method: "GET" }
    );
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(await readDriveError(response, "Could not read project metadata."));
    }
    const meta = await response.json();
    const session = auth().readSession();
    const email = session && session.email ? String(session.email).toLowerCase() : "";
    const owners = Array.isArray(meta.owners) ? meta.owners : [];
    const isOwner = owners.some(function (owner) {
      return owner && owner.emailAddress && String(owner.emailAddress).toLowerCase() === email;
    });
    if (isOwner || (meta.capabilities && meta.capabilities.canShare)) {
      cachedRole = "owner";
    } else if (meta.capabilities && meta.capabilities.canEdit === false) {
      cachedRole = "reader";
    } else {
      cachedRole = "writer";
    }
    return meta;
  }

  async function findOwnedProjectFileId(options) {
    const allowCache = !(options && options.skipCache);
    if (allowCache && cachedFileId) {
      return cachedFileId;
    }
    if (allowCache) {
      const storedId = readStoredFileId();
      if (storedId) {
        cachedFileId = storedId;
        return cachedFileId;
      }
    }

    const folderId = await ensureUndertwigFolder();
    const files = await driveSearch(
      "name = '" + CLOUD_FILE_NAME + "' and '" + folderId + "' in parents and trashed = false",
      1
    );
    cachedFileId = files[0] ? files[0].id : null;
    writeStoredFileId(cachedFileId);
    return cachedFileId;
  }

  async function findCloudFileId(options) {
    // If we already point at a shared/owned project, keep it.
    const existing = getProjectFileId();
    if (existing && !(options && options.createOwned)) {
      if (!(options && options.skipCache)) {
        cachedFileId = existing;
        return cachedFileId;
      }
    }
    return findOwnedProjectFileId(options);
  }

  async function loadProjectById(fileId) {
    const response = await driveFetch(DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media", {
      method: "GET",
    });
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      if (response.status === 403) {
        throw new Error(
          "You do not have access to this Undertwig project. Ask the owner to invite your Google account."
        );
      }
      throw new Error(await readDriveError(response, "Could not download cloud project."));
    }

    const project = await response.json();
    if (!project || typeof project !== "object" || !project.files) {
      throw new Error("Cloud project data was invalid.");
    }
    return {
      activeFile: project.activeFile || "",
      folders: Array.isArray(project.folders) ? project.folders : [],
      files: project.files || {},
    };
  }

  async function loadProject() {
    const fileId = await findCloudFileId();
    if (!fileId) {
      return null;
    }
    try {
      await refreshProjectMeta(fileId);
    } catch (_error) {
      // Role is optional for loading.
    }
    return loadProjectById(fileId);
  }

  async function saveProject(project) {
    const body = JSON.stringify({
      activeFile: project.activeFile || "",
      folders: Array.isArray(project.folders) ? project.folders : [],
      files: project.files || {},
      savedAt: new Date().toISOString(),
      version: 1,
    });

    const write = () =>
      withTimeout(writeProject(body), FETCH_TIMEOUT_MS + 5000, "Google Cloud save timed out.");

    saveChain = saveChain.then(write, write);
    return saveChain;
  }

  async function writeProject(body) {
    let fileId = getProjectFileId();
    if (!fileId) {
      fileId = await findOwnedProjectFileId({ skipCache: true });
    }

    const metadata = {
      name: CLOUD_FILE_NAME,
      mimeType: "application/json",
    };
    if (!fileId) {
      const folderId = await ensureUndertwigFolder();
      metadata.parents = [folderId];
    }

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" })
    );
    form.append("file", new Blob([body], { type: "application/json" }));

    const url = fileId
      ? DRIVE_UPLOAD + "/files/" + encodeURIComponent(fileId) + "?uploadType=multipart&fields=id"
      : DRIVE_UPLOAD + "/files?uploadType=multipart&fields=id";

    const response = await driveFetch(url, {
      method: fileId ? "PATCH" : "POST",
      body: form,
    });

    if (!response.ok) {
      if (fileId && response.status === 404) {
        setActiveProjectFileId(null);
        return writeProject(body);
      }
      throw new Error(await readDriveError(response, "Could not save project to Google Cloud storage."));
    }

    const payload = await response.json();
    if (payload && payload.id) {
      setActiveProjectFileId(payload.id);
      cachedRole = cachedRole || "owner";
    }
  }

  /**
   * Open a project shared by an owner (from an invite link).
   */
  async function joinSharedProject(fileId) {
    const id = String(fileId || "").trim();
    if (!id) {
      throw new Error("Missing shared project id.");
    }
    await connect();
    setActiveProjectFileId(id);
    const project = await loadProjectById(id);
    if (!project) {
      throw new Error("Shared project was not found.");
    }
    await refreshProjectMeta(id);
    return project;
  }

  /**
   * Share the active project with a collaborator so they edit the owner's Drive file.
   */
  async function shareProjectWithEmail(emailAddress, role) {
    const fileId = getProjectFileId();
    if (!fileId) {
      throw new Error("Connect Google Drive and sync your project before inviting collaborators.");
    }
    const email = String(emailAddress || "").trim();
    if (!email) {
      throw new Error("Enter an email address.");
    }

    await connect();
    const meta = await refreshProjectMeta(fileId);
    if (cachedRole && cachedRole !== "owner") {
      throw new Error("Only the project owner can invite collaborators.");
    }

    const response = await driveFetch(
      DRIVE_API +
        "/files/" +
        encodeURIComponent(fileId) +
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
      // Already shared is fine.
      const detail = await readDriveError(response, "Could not share the project on Google Drive.");
      if (/already|exists/i.test(detail)) {
        return { fileId: fileId, email: email, role: role || "writer", meta: meta };
      }
      throw new Error(detail);
    }

    return { fileId: fileId, email: email, role: role || "writer", meta: meta };
  }

  async function probeConnection() {
    if (!isAvailable()) {
      return { connected: false, fileId: null, role: null, reason: "not-signed-in" };
    }
    try {
      await connect();
      let fileId = getProjectFileId();
      if (fileId) {
        await refreshProjectMeta(fileId);
      } else {
        fileId = await findOwnedProjectFileId({ skipCache: true });
        if (fileId) {
          await refreshProjectMeta(fileId);
        }
      }
      return {
        connected: true,
        fileId: fileId,
        role: cachedRole,
        reason: fileId ? "ok" : "ready-no-file",
      };
    } catch (error) {
      return {
        connected: false,
        fileId: null,
        role: null,
        reason: (error && error.message) || "connection-failed",
      };
    }
  }

  async function syncProject(localProject) {
    await connect();
    const activeId = getProjectFileId();
    if (activeId) {
      const cloudProject = await loadProjectById(activeId);
      if (cloudProject && cloudProject.files && Object.keys(cloudProject.files).length) {
        try {
          await refreshProjectMeta(activeId);
        } catch (_error) {
          // Ignore.
        }
        return { project: cloudProject, source: "cloud", role: cachedRole };
      }
      // Shared/owned file exists but empty: upload local tree into that file.
      await saveProject(localProject || { activeFile: "", folders: [], files: {} });
      return { project: localProject || null, source: "uploaded", role: cachedRole };
    }

    const ownedId = await findOwnedProjectFileId({ skipCache: true });
    if (ownedId) {
      setActiveProjectFileId(ownedId);
      const cloudProject = await loadProjectById(ownedId);
      if (cloudProject && cloudProject.files && Object.keys(cloudProject.files).length) {
        await refreshProjectMeta(ownedId);
        return { project: cloudProject, source: "cloud", role: cachedRole };
      }
    }

    await saveProject(localProject || { activeFile: "", folders: [], files: {} });
    await refreshProjectMeta(getProjectFileId());
    return { project: localProject || null, source: "uploaded", role: cachedRole || "owner" };
  }

  function hasAccessToken() {
    return hydrateTokenFromStorage();
  }

  function isAvailable() {
    return Boolean(auth() && auth().isLoggedIn() && auth().getConfig().googleClientId);
  }

  function buildProjectInvitePath(fileId) {
    const id = fileId || getProjectFileId();
    if (!id) {
      return "/";
    }
    return "/?project=" + encodeURIComponent(id);
  }

  hydrateTokenFromStorage();
  if (!cachedFileId) {
    cachedFileId = readStoredFileId();
  }
  if (!cachedFolderId) {
    cachedFolderId = readStoredFolderId();
  }

  global.UndertwigCloud = {
    DRIVE_SCOPE,
    CLOUD_FILE_NAME,
    CLOUD_FOLDER_NAME,
    isAvailable,
    hasAccessToken,
    connect,
    getAccessToken,
    getProjectFileId,
    getProjectRole,
    setActiveProjectFileId,
    buildProjectInvitePath,
    joinSharedProject,
    shareProjectWithEmail,
    refreshProjectMeta,
    probeConnection,
    syncProject,
    loadProject,
    saveProject,
    clearToken,
  };
})(window);
