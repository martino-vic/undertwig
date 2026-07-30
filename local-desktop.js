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
      const meta =
        global.UndertwigLocalFs && UndertwigLocalFs.getProjectMeta(project);
      const next = await promptAbsolutePath({
        title: "Update local folder path",
        message:
          "Enter the full path of the Work desk project folder on this computer.",
        initial: (meta && meta.absolutePath) || "",
        folderName: (meta && meta.folderName) || project,
      });
      if (!next) return;
      await UndertwigLocalFs.bindProject(project, null, next);
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

  async function openSystemConsole() {
    if (!isFeatureAllowed()) return;
    const project = currentProjectName();
    if (!project) {
      if (typeof deps.setStatus === "function") {
        deps.setStatus("Set a Work desk project before opening the console.", true);
      }
      return;
    }

    let meta = UndertwigLocalFs.getProjectMeta(project);
    if (!meta || !meta.absolutePath) {
      const pathValue = await promptAbsolutePath({
        title: "Local folder path",
        message:
          "Enter the full path of “" +
          project +
          "” on this computer. Console will open your system terminal there.",
        folderName: (meta && meta.folderName) || project,
        initial: "",
      });
      if (!pathValue) {
        if (typeof deps.setStatus === "function") {
          deps.setStatus("Console cancelled.");
        }
        return;
      }
      const handle = await UndertwigLocalFs.getHandle(project);
      await UndertwigLocalFs.bindProject(project, handle, pathValue);
      meta = UndertwigLocalFs.getProjectMeta(project);
      if (typeof deps.onBindingChanged === "function") {
        deps.onBindingChanged(project);
      }
    }

    const ok = await hostHealth();
    if (!ok) {
      if (typeof deps.setStatus === "function") {
        deps.setStatus(
          "Start the local helper first: node local-console-host.mjs",
          true
        );
      }
      return;
    }

    // Warn if path looks wrong, but still allow Update flow via banner.
    await refreshLocalPathWarning();

    try {
      const response = await fetch(HOST_URL + "/open-terminal", {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: meta.absolutePath }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error((data && data.error) || "Could not open the system terminal.");
      }
      if (typeof deps.setStatus === "function") {
        deps.setStatus(
          "Opened system terminal in “" + (data.cwd || meta.absolutePath) + "”."
        );
      }
    } catch (error) {
      if (typeof deps.setStatus === "function") {
        deps.setStatus(
          (error && error.message) || "Could not open the system terminal.",
          true
        );
      }
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
    isFeatureAllowed: isFeatureAllowed,
    hostPathInfo: hostPathInfo,
    hostHealth: hostHealth,
  };
})(window);
