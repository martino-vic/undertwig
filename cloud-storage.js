(function (global) {
  const CLOUD_FILE_NAME = "undertwig-project-v1.json";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const TOKEN_STORAGE_KEY = "undertwig-drive-token-v1";
  const FILE_ID_STORAGE_KEY = "undertwig-drive-file-v1";
  const TOKEN_REQUEST_TIMEOUT_MS = 8000;
  const SILENT_TOKEN_TIMEOUT_MS = 4000;
  // Interactive Connect waits for the user to finish Google's popup — must not be short.
  const INTERACTIVE_TOKEN_TIMEOUT_MS = 120000;
  const FETCH_TIMEOUT_MS = 12000;

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
    // Empty prompt still shows Google UI when consent is missing, as long as this
    // runs from a user click. Always forcing "consent" is slower and more brittle.
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
              ? "Google Cloud authorization timed out while waiting for the permission popup. In Brave, also check Shields for this site (allow cookies/popups for accounts.google.com), then click Connect again and finish the Google dialog."
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
      // Prefer a normal token request from a user gesture; only force consent on retry.
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
        // First attempt may fail if Google requires an explicit consent screen.
        return requestOauthToken(true, INTERACTIVE_TOKEN_TIMEOUT_MS);
      }
      if (!forcePrompt && allowConsentRetry) {
        return requestOauthToken(true, INTERACTIVE_TOKEN_TIMEOUT_MS);
      }
      throw error;
    }
  }

  /** Request Drive access and keep the token for this browser session. */
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
      // Silent refresh only — never open a consent popup from a background fetch.
      await getAccessToken({ forcePrompt: false, timeoutMs: SILENT_TOKEN_TIMEOUT_MS });
      return driveFetch(url, init, true);
    }

    return response;
  }

  async function findCloudFileId(options) {
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

    const write = () =>
      withTimeout(writeProject(body), FETCH_TIMEOUT_MS + 5000, "Google Cloud save timed out.");

    // Serialize saves so rapid editor updates do not race. Recover the chain if one save fails/hangs.
    saveChain = saveChain.then(write, write);
    return saveChain;
  }

  async function writeProject(body) {
    let fileId = await findCloudFileId();
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
        fileId = null;
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

  /**
   * Lightweight connectivity check: token + Drive appData list.
   * Does not download/upload the full project (that can hang the UI on large trees).
   */
  async function probeConnection() {
    if (!isAvailable()) {
      return { connected: false, fileId: null, reason: "not-signed-in" };
    }
    try {
      await connect();
      const fileId = await findCloudFileId({ skipCache: true });
      return { connected: true, fileId: fileId, reason: fileId ? "ok" : "ready-no-file" };
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

  function hasAccessToken() {
    return hydrateTokenFromStorage();
  }

  function isAvailable() {
    return Boolean(auth() && auth().isLoggedIn() && auth().getConfig().googleClientId);
  }

  hydrateTokenFromStorage();
  if (!cachedFileId) {
    cachedFileId = readStoredFileId();
  }

  global.UndertwigCloud = {
    DRIVE_SCOPE,
    CLOUD_FILE_NAME,
    isAvailable,
    hasAccessToken,
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
