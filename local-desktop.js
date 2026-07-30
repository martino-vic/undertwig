/**
 * Desktop offline helpers: Console button (opens system terminal) + path warnings.
 */
(function (global) {
  "use strict";

  const HOST_URL = "http://127.0.0.1:" + (global.UNDERTWIG_CONSOLE_PORT || 17834);
  const DESKTOP_QUERY = "(min-width: 1181px)";

  let deps = null;
  let pathDialog = null;
  let pathDialogResolver = null;
  let warningEl = null;
  let verifyTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function isDesktopWebsite() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia(DESKTOP_QUERY).matches &&
      !document.documentElement.classList.contains("mobile-gate")
    );
  }

  function isFeatureAllowed() {
    if (!deps || (typeof deps.isLoggedIn === "function" && deps.isLoggedIn())) {
      return false;
    }
    return isDesktopWebsite();
  }

  function currentProjectName() {
    return deps && typeof deps.getActiveProjectName === "function"
      ? deps.getActiveProjectName() || ""
      : "";
  }

  async function hostHealth() {
    try {
      const response = await fetch(HOST_URL + "/health", {
        method: "GET",
        mode: "cors",
        cache: "no-store",
      });
      if (!response.ok) return false;
      const data = await response.json();
      return Boolean(data && data.ok);
    } catch (_error) {
      return false;
    }
  }

  async function hostPathInfo(absolutePath) {
    const response = await fetch(
      HOST_URL + "/path-info?path=" + encodeURIComponent(absolutePath),
      { method: "GET", mode: "cors", cache: "no-store" }
    );
    if (!response.ok) {
      return { reachable: false, exists: false };
    }
    const data = await response.json();
    return {
      reachable: true,
      exists: Boolean(data && data.exists),
      baseName: data && data.baseName ? data.baseName : "",
      path: data && data.path ? data.path : absolutePath,
    };
  }

  /**
   * Native folder dialog via the local helper — returns absolute path + file bytes.
   * Browsers cannot expose this path from their own pickers.
   */
  async function importProjectViaHost() {
    const response = await fetch(HOST_URL + "/import-project", {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new Error("Local helper returned an invalid response.");
    }
    if (data && data.cancelled) {
      const error = new Error("Project import cancelled.");
      error.name = "AbortError";
      throw error;
    }
    if (!response.ok || !data || !data.ok) {
      throw new Error(
        (data && data.error) || "Could not import the project folder."
      );
    }
    return {
      absolutePath: data.path,
      folderName: data.folderName || "",
      files: Array.isArray(data.files) ? data.files : [],
    };
  }

  async function writeProjectViaHost(absolutePath, files) {
    const response = await fetch(HOST_URL + "/write-project", {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: absolutePath,
        files: files || [],
      }),
    });
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new Error("Local helper returned an invalid response.");
    }
    if (!response.ok || !data || !data.ok) {
      throw new Error(
        (data && data.error) || "Could not save to the local folder."
      );
    }
    return data;
  }

  function ensureWarningBanner() {
    if (warningEl) return warningEl;
    const workspace = document.querySelector("section.workspace");
    if (!workspace) return null;
    const el = document.createElement("div");
    el.id = "localPathWarning";
    el.className = "local-path-warning hidden";
    el.hidden = true;
    el.setAttribute("role", "status");
    el.innerHTML =
      '<div class="local-path-warning-text"></div>' +
      '<div class="local-path-warning-actions">' +
      '<button type="button" id="localPathWarningUpdate">Update path</button>' +
      '<button type="button" id="localPathWarningDismiss">Dismiss</button>' +
      "</div>";
    const status = $("status");
    if (status && status.parentElement === workspace) {
      workspace.insertBefore(el, status);
    } else {
      workspace.appendChild(el);
    }
    el.querySelector("#localPathWarningDismiss").addEventListener("click", function () {
      hideWarning();
    });
    el.querySelector("#localPathWarningUpdate").addEventListener("click", async function () {
      const project = currentProjectName();
      if (!project) return;
      let next = "";
      if (await hostHealth()) {
        try {
          const response = await fetch(HOST_URL + "/pick-directory", {
            method: "POST",
            mode: "cors",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const data = await response.json();
          if (response.ok && data && data.ok && data.path) {
            next = data.path;
          }
        } catch (_error) {
          // Fall through.
        }
      }
      if (!next) {
        const meta =
          global.UndertwigLocalFs && UndertwigLocalFs.getProjectMeta(project);
        next = await promptAbsolutePath({
          title: "Update local folder path",
          message:
            "Choose or enter the full path of the Work desk project folder. Tip: install Undertwig Local to pick it with a normal folder dialog.",
          initial: (meta && meta.absolutePath) || "",
          folderName: (meta && meta.folderName) || project,
        });
      }
      if (!next) return;
      const handle = await UndertwigLocalFs.getHandle(project);
      await UndertwigLocalFs.bindProject(project, handle, next);
      if (typeof deps.onBindingChanged === "function") {
        deps.onBindingChanged(project);
      }
      await refreshLocalPathWarning();
    });
    warningEl = el;
    return el;
  }

  function hideWarning() {
    const el = ensureWarningBanner();
    if (!el) return;
    el.hidden = true;
    el.classList.add("hidden");
    const text = el.querySelector(".local-path-warning-text");
    if (text) text.textContent = "";
  }

  function showWarning(message) {
    const el = ensureWarningBanner();
    if (!el) return;
    const text = el.querySelector(".local-path-warning-text");
    if (text) text.textContent = message;
    el.hidden = false;
    el.classList.remove("hidden");
  }

  function ensurePathDialog() {
    if (pathDialog) return pathDialog;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay hidden";
    overlay.id = "localPathDialog";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    overlay.inert = true;
    overlay.innerHTML =
      '<div class="modal-card">' +
      '<h2 id="localPathTitle">Local folder path</h2>' +
      '<p id="localPathMessage">Browsers cannot read the full disk path. Enter it so Console can open your system terminal there.</p>' +
      '<label class="local-path-field-label" for="localPathInput">Full path</label>' +
      '<input id="localPathInput" class="local-path-input" type="text" spellcheck="false" autocomplete="off">' +
      '<div class="modal-actions">' +
      '<button type="button" id="localPathCancel">Cancel</button>' +
      '<button type="button" class="modal-confirm" id="localPathConfirm">Save path</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    function close(result) {
      overlay.classList.add("hidden");
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
      const resolve = pathDialogResolver;
      pathDialogResolver = null;
      if (resolve) resolve(result);
    }

    overlay.querySelector("#localPathCancel").addEventListener("click", function () {
      close(null);
    });
    overlay.querySelector("#localPathConfirm").addEventListener("click", function () {
      const value = String(overlay.querySelector("#localPathInput").value || "").trim();
      close(value || null);
    });
    overlay.querySelector("#localPathInput").addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        overlay.querySelector("#localPathConfirm").click();
      }
    });
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close(null);
    });
    document.addEventListener("keydown", function (event) {
      if (
        event.key === "Escape" &&
        pathDialog &&
        !pathDialog.hidden
      ) {
        event.preventDefault();
        close(null);
      }
    });

    pathDialog = overlay;
    return overlay;
  }

  function promptAbsolutePath(options) {
    const opts = options || {};
    const overlay = ensurePathDialog();
    overlay.querySelector("#localPathTitle").textContent =
      opts.title || "Local folder path";
    overlay.querySelector("#localPathMessage").textContent =
      opts.message ||
      "Enter the full path of this project folder on your computer.";
    const input = overlay.querySelector("#localPathInput");
    const folderName = opts.folderName || "";
    input.value = opts.initial || "";
    input.placeholder = folderName
      ? "/home/you/Documents/" + folderName
      : "/full/path/to/project";
    overlay.classList.remove("hidden");
    overlay.hidden = false;
    overlay.removeAttribute("aria-hidden");
    overlay.inert = false;
    setTimeout(function () {
      input.focus();
      input.select();
    }, 0);
    return new Promise(function (resolve) {
      pathDialogResolver = resolve;
    });
  }

  async function refreshVisibility() {
    const button = $("localConsoleButton");
    const allowed = isFeatureAllowed();
    if (button) {
      button.hidden = !allowed;
      button.classList.toggle("hidden", !allowed);
    }
    if (typeof deps.onVisibilityChange === "function") {
      deps.onVisibilityChange(allowed);
    }
    if (!allowed) {
      hideWarning();
      return;
    }
    await refreshLocalPathWarning();
  }

  async function refreshLocalPathWarning() {
    if (!isFeatureAllowed() || !global.UndertwigLocalFs) {
      hideWarning();
      return;
    }
    const project = currentProjectName();
    if (!project) {
      hideWarning();
      return;
    }
    const hostUp = await hostHealth();
    const result = await UndertwigLocalFs.verifyLocalBinding(
      project,
      hostUp
        ? function (absolutePath) {
            return hostPathInfo(absolutePath);
          }
        : null
    );
    if (result && result.warning) {
      showWarning(result.warning);
    } else {
      hideWarning();
    }
  }

  function detectDesktopOs() {
    const ua = String(
      (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.platform ||
        navigator.userAgent ||
        ""
    ).toLowerCase();
    if (ua.indexOf("mac") !== -1 || ua.indexOf("iphone") !== -1) return "mac";
    if (ua.indexOf("win") !== -1) return "windows";
    return "linux";
  }

  function shellQuote(value) {
    return "'" + String(value || "").replace(/'/g, "'\\''") + "'";
  }

  function buildTerminalLauncher(cwd) {
    const osName = detectDesktopOs();
    if (osName === "windows") {
      return {
        filename: "undertwig-console.bat",
        mime: "application/x-bat",
        body:
          "@echo off\r\n" +
          "cd /d " +
          String(cwd).replace(/\r|\n/g, "") +
          "\r\n" +
          "start \"Undertwig\" cmd.exe\r\n",
        openCommand:
          'start cmd.exe /k cd /d "' + String(cwd).replace(/"/g, "") + '"',
      };
    }
    if (osName === "mac") {
      return {
        filename: "undertwig-console.command",
        mime: "application/x-sh",
        body:
          "#!/bin/bash\n" +
          "cd " +
          shellQuote(cwd) +
          " || exit 1\n" +
          'open -a Terminal "' +
          String(cwd).replace(/"/g, '\\"') +
          '"\n',
        openCommand: "open -a Terminal " + shellQuote(cwd),
      };
    }
    return {
      filename: "undertwig-console.sh",
      mime: "application/x-sh",
      body:
        "#!/bin/bash\n" +
        "DIR=" +
        shellQuote(cwd) +
        "\n" +
        'cd "$DIR" || exit 1\n' +
        'if command -v x-terminal-emulator >/dev/null 2>&1; then exec x-terminal-emulator --working-directory="$DIR"; fi\n' +
        'if command -v gnome-terminal >/dev/null 2>&1; then exec gnome-terminal --working-directory="$DIR"; fi\n' +
        'if command -v konsole >/dev/null 2>&1; then exec konsole --workdir "$DIR"; fi\n' +
        'if command -v xfce4-terminal >/dev/null 2>&1; then exec xfce4-terminal --working-directory="$DIR"; fi\n' +
        'if command -v kitty >/dev/null 2>&1; then exec kitty --directory "$DIR"; fi\n' +
        'if command -v xterm >/dev/null 2>&1; then exec xterm -e bash -lc "cd \"$DIR\"; exec bash"; fi\n' +
        'echo "No terminal emulator found."; exec bash\n',
      openCommand:
        "x-terminal-emulator --working-directory=" +
        shellQuote(cwd) +
        " || gnome-terminal --working-directory=" +
        shellQuote(cwd),
    };
  }

  function downloadTextFile(filename, body, mime) {
    const blob = new Blob([body], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_error) {
      // Fall through.
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (_error) {
      return false;
    }
  }

  async function ensureProjectAbsolutePath(project) {
    let meta = UndertwigLocalFs.getProjectMeta(project);
    if (meta && meta.absolutePath) {
      return meta.absolutePath;
    }

    // Prefer a native pick through the helper when it is already running.
    if (await hostHealth()) {
      try {
        const response = await fetch(HOST_URL + "/pick-directory", {
          method: "POST",
          mode: "cors",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = await response.json();
        if (response.ok && data && data.ok && data.path) {
          const handle = await UndertwigLocalFs.getHandle(project);
          await UndertwigLocalFs.bindProject(project, handle, data.path);
          if (typeof deps.onBindingChanged === "function") {
            deps.onBindingChanged(project);
          }
          return data.path;
        }
      } catch (_error) {
        // Fall through to manual path entry.
      }
    }

    const pathValue = await promptAbsolutePath({
      title: "Local folder path",
      message:
        "Enter the full path of “" +
        project +
        "” on this computer. Console opens your system terminal there.",
      folderName: (meta && meta.folderName) || project,
      initial: "",
    });
    if (!pathValue) {
      return "";
    }
    const handle = await UndertwigLocalFs.getHandle(project);
    await UndertwigLocalFs.bindProject(project, handle, pathValue);
    if (typeof deps.onBindingChanged === "function") {
      deps.onBindingChanged(project);
    }
    return pathValue;
  }

  async function openTerminalViaHelper(cwd) {
    const response = await fetch(HOST_URL + "/open-terminal", {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwd }),
    });
    const data = await response.json();
    if (!response.ok || !data || !data.ok) {
      throw new Error((data && data.error) || "Could not open the system terminal.");
    }
    return data;
  }

  function companionInstallerUrl() {
    const osName = detectDesktopOs();
    if (osName === "windows") {
      return "local-helper/install.ps1";
    }
    if (osName === "mac") {
      return "local-helper/install.command";
    }
    return "local-helper/install.sh";
  }

  function ensureCompanionDialog() {
    let overlay = $("localCompanionDialog");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "modal-overlay hidden";
    overlay.id = "localCompanionDialog";
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    overlay.inert = true;
    overlay.innerHTML =
      '<div class="modal-card">' +
      "<h2>Install Undertwig Local</h2>" +
      "<p>" +
      "A tiny companion app runs in the background so Console can open your system terminal " +
      "and Import can remember the real folder path — without typing commands." +
      "</p>" +
      "<p>" +
      "Install once (requires free Node.js). After that it starts automatically when you log in." +
      "</p>" +
      '<div class="modal-actions">' +
      '<button type="button" id="localCompanionLater">Not now</button>' +
      '<button type="button" class="modal-confirm" id="localCompanionInstall">Download installer</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);
    overlay.querySelector("#localCompanionLater").addEventListener("click", function () {
      overlay.classList.add("hidden");
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
    });
    overlay.querySelector("#localCompanionInstall").addEventListener("click", function () {
      const url = companionInstallerUrl();
      const a = document.createElement("a");
      a.href = url;
      a.download = url.split("/").pop();
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (typeof deps.setStatus === "function") {
        deps.setStatus(
          "Downloaded the Undertwig Local installer — open it to finish setup. It will run in the background afterwards."
        );
      }
      overlay.classList.add("hidden");
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
      overlay.inert = true;
    });
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        overlay.querySelector("#localCompanionLater").click();
      }
    });
    return overlay;
  }

  function offerCompanionInstall() {
    const overlay = ensureCompanionDialog();
    overlay.classList.remove("hidden");
    overlay.hidden = false;
    overlay.removeAttribute("aria-hidden");
    overlay.inert = false;
  }

  async function wakeCompanion() {
    if (await hostHealth()) {
      return true;
    }
    // If the one-time installer registered the protocol, this starts the companion.
    try {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = "undertwig-local://start";
      document.body.appendChild(iframe);
      setTimeout(function () {
        iframe.remove();
      }, 2000);
    } catch (_error) {
      // Ignore.
    }
    for (let i = 0; i < 12; i += 1) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 250);
      });
      if (await hostHealth()) {
        return true;
      }
    }
    return false;
  }

  async function openSystemConsole() {
    if (!isFeatureAllowed()) return;
    const project = currentProjectName();
    if (!project) {
      if (typeof deps.setStatus === "function") {
        deps.setStatus("Set a Work desk project before opening the console.", true);
      }
      return;
    }

    if (!(await hostHealth())) {
      const woke = await wakeCompanion();
      if (!woke) {
        offerCompanionInstall();
        // Still allow path + launcher fallback below after install prompt.
      }
    }

    const cwd = await ensureProjectAbsolutePath(project);
    if (!cwd) {
      if (typeof deps.setStatus === "function") {
        deps.setStatus("Console cancelled.");
      }
      return;
    }

    await refreshLocalPathWarning();

    if (await hostHealth()) {
      try {
        const data = await openTerminalViaHelper(cwd);
        if (typeof deps.setStatus === "function") {
          deps.setStatus(
            "Opened system terminal in “" + (data.cwd || cwd) + "”."
          );
        }
        return;
      } catch (error) {
        console.warn("[undertwig] companion open-terminal failed", error);
      }
    }

    // Fallback without companion: download a one-click launcher.
    const launcher = buildTerminalLauncher(cwd);
    downloadTextFile(launcher.filename, launcher.body, launcher.mime);
    const copied = await copyText(launcher.openCommand);
    if (typeof deps.setStatus === "function") {
      deps.setStatus(
        copied
          ? "Downloaded " +
              launcher.filename +
              " — open it to launch the terminal. Or install Undertwig Local for one-click Console."
          : "Downloaded " +
              launcher.filename +
              " — open it to launch the terminal in “" +
              cwd +
              "”."
      );
    }
  }

  function scheduleVerify() {
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(function () {
      refreshLocalPathWarning();
    }, 200);
  }

  function bindUi() {
    const button = $("localConsoleButton");
    if (button) {
      button.addEventListener("click", function () {
        openSystemConsole();
      });
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") scheduleVerify();
    });
    window.addEventListener("focus", scheduleVerify);
    if (typeof window.matchMedia === "function") {
      const mq = window.matchMedia(DESKTOP_QUERY);
      const onChange = function () {
        refreshVisibility();
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onChange);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onChange);
      }
    }
  }

  function init(options) {
    deps = options || {};
    bindUi();
    refreshVisibility();
  }

  global.UndertwigLocalDesktop = {
    init: init,
    refreshVisibility: refreshVisibility,
    refreshLocalPathWarning: refreshLocalPathWarning,
    promptAbsolutePath: promptAbsolutePath,
    openSystemConsole: openSystemConsole,
    importProjectViaHost: importProjectViaHost,
    writeProjectViaHost: writeProjectViaHost,
    offerCompanionInstall: offerCompanionInstall,
    wakeCompanion: wakeCompanion,
    isFeatureAllowed: isFeatureAllowed,
    hostPathInfo: hostPathInfo,
    hostHealth: hostHealth,
  };
})(window);
