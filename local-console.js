/**
 * Desktop offline local console UI (bottom drawer).
 * Talks to local-console-host.mjs on 127.0.0.1 for real shell / git commands.
 */
(function (global) {
  "use strict";

  const HOST_URL = "http://127.0.0.1:" + (global.UNDERTWIG_CONSOLE_PORT || 17834);
  const DESKTOP_QUERY = "(min-width: 1181px)";
  const OPEN_KEY = "undertwig-local-console-open-v1";
  const COLLAPSED_KEY = "undertwig-local-console-collapsed-v1";

  let deps = null;
  let hostOk = null;
  let history = [];
  let historyIndex = -1;

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
    if (!deps) {
      return false;
    }
    if (typeof deps.isLoggedIn === "function" && deps.isLoggedIn()) {
      return false;
    }
    return isDesktopWebsite();
  }

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === "1";
    } catch (_error) {
      return false;
    }
  }

  function writeFlag(key, on) {
    try {
      if (on) {
        localStorage.setItem(key, "1");
      } else {
        localStorage.removeItem(key);
      }
    } catch (_error) {
      // Ignore.
    }
  }

  function appendOutput(text, className) {
    const pre = $("localConsoleOutput");
    if (!pre) {
      return;
    }
    const line = document.createElement("div");
    if (className) {
      line.className = className;
    }
    line.textContent = text == null ? "" : String(text);
    pre.appendChild(line);
    pre.scrollTop = pre.scrollHeight;
  }

  function clearOutput() {
    const pre = $("localConsoleOutput");
    if (pre) {
      pre.textContent = "";
    }
  }

  async function checkHost() {
    try {
      const response = await fetch(HOST_URL + "/health", {
        method: "GET",
        mode: "cors",
        cache: "no-store",
      });
      if (!response.ok) {
        hostOk = false;
        return false;
      }
      const data = await response.json();
      hostOk = Boolean(data && data.ok);
      return hostOk;
    } catch (_error) {
      hostOk = false;
      return false;
    }
  }

  function currentProjectName() {
    return deps && typeof deps.getActiveProjectName === "function"
      ? deps.getActiveProjectName() || ""
      : "";
  }

  function syncCwdInput() {
    const input = $("localConsoleCwd");
    if (!input || !global.UndertwigLocalFs) {
      return;
    }
    const project = currentProjectName();
    input.value = global.UndertwigLocalFs.getConsoleCwd(project) || "";
    input.placeholder = project
      ? "/full/path/to/" + project
      : "/full/path/to/project";
  }

  function persistCwdFromInput() {
    const input = $("localConsoleCwd");
    if (!input || !global.UndertwigLocalFs) {
      return "";
    }
    const project = currentProjectName();
    const cwd = String(input.value || "").trim();
    global.UndertwigLocalFs.setConsoleCwd(project, cwd);
    return cwd;
  }

  function setOpen(open) {
    const panel = $("localConsole");
    const button = $("localConsoleButton");
    if (!panel) {
      return;
    }
    const allowed = isFeatureAllowed();
    const show = Boolean(open) && allowed;
    panel.hidden = !show;
    panel.classList.toggle("hidden", !show);
    panel.setAttribute("aria-hidden", show ? "false" : "true");
    document.documentElement.classList.toggle("local-console-open", show);
    if (button) {
      button.setAttribute("aria-expanded", show ? "true" : "false");
    }
    writeFlag(OPEN_KEY, show);
    if (show) {
      syncCwdInput();
      const collapsed = readFlag(COLLAPSED_KEY);
      setCollapsed(collapsed);
      if (!collapsed) {
        const input = $("localConsoleInput");
        if (input) {
          input.focus();
        }
      }
    }
    updateConsoleHeightVar();
  }

  function setCollapsed(collapsed) {
    const panel = $("localConsole");
    const toggle = $("localConsoleCollapse");
    if (!panel) {
      return;
    }
    panel.classList.toggle("is-collapsed", Boolean(collapsed));
    if (toggle) {
      toggle.textContent = collapsed ? "Expand" : "Collapse";
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    writeFlag(COLLAPSED_KEY, Boolean(collapsed));
    document.documentElement.classList.toggle(
      "local-console-collapsed",
      Boolean(collapsed) && !panel.hidden
    );
    updateConsoleHeightVar();
  }

  function updateConsoleHeightVar() {
    const panel = $("localConsole");
    const root = document.documentElement;
    if (!panel || panel.hidden) {
      root.style.setProperty("--local-console-offset", "0px");
      return;
    }
    const height = panel.offsetHeight || 0;
    root.style.setProperty("--local-console-offset", height + "px");
  }

  async function ensureWelcome() {
    const pre = $("localConsoleOutput");
    if (!pre || pre.childNodes.length) {
      return;
    }
    const project = currentProjectName();
    appendOutput("Undertwig local console", "local-console-meta");
    appendOutput(
      project
        ? "Work desk project: " + project
        : "No project on the Work desk yet.",
      "local-console-meta"
    );
    const ok = await checkHost();
    if (ok) {
      appendOutput("Console host connected on " + HOST_URL, "local-console-ok");
    } else {
      appendOutput(
        "Console host is not running. In a terminal, start:",
        "local-console-warn"
      );
      appendOutput("  node local-console-host.mjs", "local-console-meta");
      appendOutput(
        "Then set cwd below to the folder this project was opened from.",
        "local-console-warn"
      );
    }
    appendOutput(
      "Save writes to the browser and, when a folder is linked, back to that folder.",
      "local-console-meta"
    );
  }

  async function runCommand(command) {
    const trimmed = String(command || "").trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "clear" || trimmed === "cls") {
      clearOutput();
      return;
    }
    if (trimmed === "help") {
      appendOutput(
        "Commands run on your machine via the local console host (git, ls, …).\n" +
          "Built-ins: help, clear, host\n" +
          "Set cwd to the absolute path of the Work desk project folder.",
        "local-console-meta"
      );
      return;
    }
    if (trimmed === "host") {
      const ok = await checkHost();
      appendOutput(
        ok ? "Host OK: " + HOST_URL : "Host not reachable at " + HOST_URL,
        ok ? "local-console-ok" : "local-console-error"
      );
      return;
    }

    const cwd = persistCwdFromInput();
    appendOutput("$ " + trimmed, "local-console-cmd");
    if (!cwd) {
      appendOutput(
        "Set cwd to the full path of your local project folder first.",
        "local-console-error"
      );
      return;
    }

    const ok = hostOk === true ? true : await checkHost();
    if (!ok) {
      appendOutput(
        "Console host is not running. Start: node local-console-host.mjs",
        "local-console-error"
      );
      return;
    }

    try {
      const response = await fetch(HOST_URL + "/exec", {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed, cwd: cwd }),
      });
      const data = await response.json();
      if (!response.ok || (data && data.error && data.stdout == null && data.stderr == null)) {
        appendOutput(
          (data && data.error) || "Command failed (" + response.status + ")",
          "local-console-error"
        );
        return;
      }
      if (data.stdout) {
        appendOutput(data.stdout.replace(/\n$/, ""), "local-console-stdout");
      }
      if (data.stderr) {
        appendOutput(data.stderr.replace(/\n$/, ""), "local-console-stderr");
      }
      if (!data.stdout && !data.stderr) {
        appendOutput(
          data.ok
            ? "(no output)"
            : "exit " + (data.exitCode == null ? "?" : data.exitCode),
          "local-console-meta"
        );
      } else if (!data.ok && data.exitCode != null) {
        appendOutput("exit " + data.exitCode, "local-console-meta");
      }
    } catch (_error) {
      hostOk = false;
      appendOutput(
        "Could not reach the console host. Start: node local-console-host.mjs",
        "local-console-error"
      );
    }
  }

  async function linkFolderForCurrentProject() {
    if (!global.UndertwigLocalFs || !global.UndertwigLocalFs.supportsDirectoryPicker()) {
      appendOutput(
        "Linking a local folder needs Chrome or Edge on desktop.",
        "local-console-error"
      );
      return;
    }
    const project = currentProjectName();
    if (!project) {
      appendOutput("Set a Work desk project before linking a folder.", "local-console-error");
      return;
    }
    try {
      const handle = await global.UndertwigLocalFs.pickProjectDirectory();
      const allowed = await global.UndertwigLocalFs.ensureReadWritePermission(handle);
      if (!allowed) {
        appendOutput("Folder permission denied.", "local-console-error");
        return;
      }
      await global.UndertwigLocalFs.putHandle(project, handle);
      if (!global.UndertwigLocalFs.getConsoleCwd(project) && handle.name) {
        // Path unknown from the picker; keep cwd empty but hint with folder name.
        syncCwdInput();
      }
      appendOutput(
        "Linked local folder “" +
          (handle.name || project) +
          "” for Save. Set cwd to its full path for shell commands.",
        "local-console-ok"
      );
      if (typeof deps.onFolderLinked === "function") {
        deps.onFolderLinked(project, handle);
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        appendOutput("Link folder cancelled.", "local-console-meta");
        return;
      }
      appendOutput(
        (error && error.message) || "Could not link folder.",
        "local-console-error"
      );
    }
  }

  function refreshVisibility() {
    const button = $("localConsoleButton");
    const allowed = isFeatureAllowed();
    if (button) {
      button.hidden = !allowed;
      button.classList.toggle("hidden", !allowed);
    }
    if (!allowed) {
      setOpen(false);
      return;
    }
    if (readFlag(OPEN_KEY)) {
      setOpen(true);
      ensureWelcome();
    } else {
      updateConsoleHeightVar();
    }
  }

  function bindUi() {
    const button = $("localConsoleButton");
    const closeBtn = $("localConsoleClose");
    const collapseBtn = $("localConsoleCollapse");
    const linkBtn = $("localConsoleLinkFolder");
    const input = $("localConsoleInput");
    const cwdInput = $("localConsoleCwd");

    if (button) {
      button.addEventListener("click", async function () {
        const panel = $("localConsole");
        const opening = !panel || panel.hidden;
        setOpen(opening);
        if (opening) {
          await ensureWelcome();
        }
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        setOpen(false);
      });
    }
    if (collapseBtn) {
      collapseBtn.addEventListener("click", function () {
        const panel = $("localConsole");
        setCollapsed(!(panel && panel.classList.contains("is-collapsed")));
      });
    }
    if (linkBtn) {
      linkBtn.addEventListener("click", function () {
        linkFolderForCurrentProject();
      });
    }
    if (cwdInput) {
      cwdInput.addEventListener("change", persistCwdFromInput);
      cwdInput.addEventListener("blur", persistCwdFromInput);
    }
    if (input) {
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          const value = input.value;
          input.value = "";
          if (value.trim()) {
            history.push(value);
            historyIndex = history.length;
          }
          runCommand(value);
          return;
        }
        if (event.key === "ArrowUp") {
          if (!history.length) return;
          event.preventDefault();
          historyIndex = Math.max(0, historyIndex - 1);
          input.value = history[historyIndex] || "";
          return;
        }
        if (event.key === "ArrowDown") {
          if (!history.length) return;
          event.preventDefault();
          historyIndex = Math.min(history.length, historyIndex + 1);
          input.value = historyIndex >= history.length ? "" : history[historyIndex] || "";
        }
      });
    }

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
    window.addEventListener("resize", updateConsoleHeightVar);
  }

  function init(options) {
    deps = options || {};
    bindUi();
    refreshVisibility();
  }

  global.UndertwigLocalConsole = {
    init: init,
    refreshVisibility: refreshVisibility,
    syncCwdInput: syncCwdInput,
    setOpen: setOpen,
    isFeatureAllowed: isFeatureAllowed,
    isDesktopWebsite: isDesktopWebsite,
    linkFolderForCurrentProject: linkFolderForCurrentProject,
    appendOutput: appendOutput,
  };
})(window);
