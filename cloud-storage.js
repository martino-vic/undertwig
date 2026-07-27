(function (global) {
  const CLOUD_FILE_NAME = "undertwig-project-v1.json";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const TOKEN_STORAGE_KEY = "undertwig-drive-token-v1";
  const FILE_ID_STORAGE_KEY = "undertwig-drive-file-v1";

  let memoryAccessToken = null;
  let memoryTokenExpiresAt = 0;
  let cachedFileId = null;
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
      // sessionStorage may be unavailable; in-memory token still works for this page.
    }
  }

  function readStoredFileId() {
    try {
      return sessionStorage.getItem(FILE_ID_STORAGE_KEY) || null;
    } catch (_error) {
      return null;
    }
  }

  function writeStoredFileId(fileId) {
    try {
      if (fileId) {
        sessionStorage.setItem(FILE_ID_STORAGE_KEY, String(fileId));
      } else {
        sessionStorage.removeItem(FILE_ID_STORAGE_KEY);
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
    cachedFileId = null;
    writeStoredFileId(null);
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

  async function requestOauthToken(forcePrompt) {
    const session = auth().readSession();
    if (!session) {
      throw new Error("Sign in to use Google Cloud storage.");
    }

    const clientId = auth().getConfig().googleClientId;
    if (!clientId) {
      throw new Error("Google Cloud storage is not configured.");
    }

    await ensureGisOauth();

    const token = await new Promise((resolve, reject) => {
      try {
        const client = global.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: DRIVE_SCOPE,
          prompt: forcePrompt ? "consent" : "",
          hint: session.email,
          callback: (response) => {
            if (response && response.error) {
              reject(new Error(describeOauthError(response)));
              return;
            }
            if (!response || !response.access_token) {
              reject(new Error("Google did not return a cloud storage access token."));
              return;
            }
            resolve(response);
          },
          error_callback: (error) => {
            reject(new Error((error && error.message) || "Google cloud storage authorization failed."));
          },
        });
        client.requestAccessToken();
      } catch (error) {
        reject(error);
      }
    });

    return rememberToken(token);
  }

  async function getAccessToken(options) {
    const forcePrompt = Boolean(options && options.forcePrompt);
    const allowConsentRetry = Boolean(options && options.allowConsentRetry);
    if (!forcePrompt && hydrateTokenFromStorage()) {
      return memoryAccessToken;
    }

    try {
      return await requestOauthToken(forcePrompt);
    } catch (error) {
      // Used right after Google sign-in (user gesture) so Drive consent can complete.
      if (!forcePrompt && allowConsentRetry) {
        return requestOauthToken(true);
      }
      throw error;
    }
  }

  /** Request Drive access and keep the token for this browser session. */
  async function connect(options) {
    const opts = options || {};
    return getAccessToken({
      forcePrompt: Boolean(opts.forcePrompt),
      allowConsentRetry: Boolean(opts.interactive || opts.allowConsentRetry),
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

  async function driveFetch(url, init, retried) {
    const token = await getAccessToken();
    const headers = Object.assign({}, (init && init.headers) || {}, {
      Authorization: "Bearer " + token,
    });
    const response = await fetch(url, Object.assign({}, init, { headers, credentials: "omit" }));

    if (response.status === 401 && !retried) {
      forgetAccessToken();
      await getAccessToken({ forcePrompt: true });
      return driveFetch(url, init, true);
    }

    return response;
  }

  async function findCloudFileId() {
    if (cachedFileId) {
      return cachedFileId;
    }
    const storedId = readStoredFileId();
    if (storedId) {
      cachedFileId = storedId;
      return cachedFileId;
    }

    const query = encodeURIComponent("name = '" + CLOUD_FILE_NAME + "' and trashed = false");
    const url =
      DRIVE_API +
      "/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&q=" +
      query +
      "&pageSize=1";
    const response = await driveFetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(await readDriveError(response, "Could not look up cloud project file."));
    }
    const payload = await response.json();
    const file = payload.files && payload.files[0];
    cachedFileId = file ? file.id : null;
    writeStoredFileId(cachedFileId);
    return cachedFileId;
  }

  async function readDriveError(response, fallback) {
    try {
      const payload = await response.json();
      if (payload && payload.error && payload.error.message) {
        return payload.error.message;
      }
    } catch (_error) {
      // Ignore JSON parse failures.
    }
    return fallback + " (HTTP " + response.status + ")";
  }

  async function loadProject() {
    const fileId = await findCloudFileId();
    if (!fileId) {
      return null;
    }

    const response = await driveFetch(DRIVE_API + "/files/" + encodeURIComponent(fileId) + "?alt=media", {
      method: "GET",
    });
    if (!response.ok) {
      // Stale cached id: forget it and treat as no cloud project.
      if (response.status === 404) {
        cachedFileId = null;
        writeStoredFileId(null);
        return null;
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

  async function saveProject(project) {
    const body = JSON.stringify({
      activeFile: project.activeFile || "",
      folders: Array.isArray(project.folders) ? project.folders : [],
      files: project.files || {},
      savedAt: new Date().toISOString(),
      version: 1,
    });

    // Serialize saves so rapid editor updates do not race.
    saveChain = saveChain.then(() => writeProject(body), () => writeProject(body));
    return saveChain;
  }

  async function writeProject(body) {
    const fileId = await findCloudFileId();
    const metadata = {
      name: CLOUD_FILE_NAME,
      mimeType: "application/json",
    };
    if (!fileId) {
      metadata.parents = ["appDataFolder"];
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
        cachedFileId = null;
        writeStoredFileId(null);
        return writeProject(body);
      }
      throw new Error(await readDriveError(response, "Could not save project to Google Cloud storage."));
    }

    const payload = await response.json();
    if (payload && payload.id) {
      cachedFileId = payload.id;
      writeStoredFileId(cachedFileId);
    }
  }

  function getProjectFileId() {
    return cachedFileId || readStoredFileId() || null;
  }

  async function probeConnection() {
    if (!isAvailable()) {
      return { connected: false, fileId: null, reason: "not-signed-in" };
    }
    try {
      await connect();
      const fileId = await findCloudFileId();
      if (!fileId) {
        return { connected: true, fileId: null, reason: "ready-no-file" };
      }
      return { connected: true, fileId: fileId, reason: "ok" };
    } catch (error) {
      return {
        connected: false,
        fileId: null,
        reason: (error && error.message) || "connection-failed",
      };
    }
  }

  /** Load cloud project if present; otherwise upload the provided local project. */
  async function syncProject(localProject) {
    await connect();
    const cloudProject = await loadProject();
    if (cloudProject && cloudProject.files && Object.keys(cloudProject.files).length) {
      return { project: cloudProject, source: "cloud" };
    }
    await saveProject(localProject || { activeFile: "", folders: [], files: {} });
    return { project: localProject || null, source: "uploaded" };
  }

  function isAvailable() {
    return Boolean(auth() && auth().isLoggedIn() && auth().getConfig().googleClientId);
  }

  // Restore any token left from login redirect / prior page in this tab.
  hydrateTokenFromStorage();
  if (!cachedFileId) {
    cachedFileId = readStoredFileId();
  }

  global.UndertwigCloud = {
    DRIVE_SCOPE,
    CLOUD_FILE_NAME,
    isAvailable,
    connect,
    getAccessToken,
    getProjectFileId,
    probeConnection,
    syncProject,
    loadProject,
    saveProject,
    clearToken,
  };
})(window);
