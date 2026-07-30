#!/usr/bin/env node
/**
 * Undertwig local helper — native folder pick, disk save, and system terminal.
 *
 *   node local-console-host.mjs
 *
 * Binds 127.0.0.1 only. Used on desktop when logged out.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const HOST = "127.0.0.1";
const PORT = Number(process.env.UNDERTWIG_CONSOLE_PORT || 17834);
const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".svn",
  ".hg",
  "__MACOSX",
]);
const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_IMPORT_FILES = 8000;
const MAX_WRITE_BODY = 100 * 1024 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function corsPreflight(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

function readBody(req, maxBytes) {
  const limit = maxBytes || 200_000;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveExistingDir(cwd) {
  const raw = String(cwd || "").trim();
  if (!raw) {
    throw new Error("Missing folder path.");
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Not an existing directory: " + resolved);
  }
  return resolved;
}

function runCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      windowsHide: true,
      ...(options || {}),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (buf) => {
      out += buf.toString("utf8");
    });
    child.stderr.on("data", (buf) => {
      err += buf.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(out.trim());
        return;
      }
      // zenity/kdialog/osascript often use 1 for cancel
      if (code === 1) {
        const error = new Error("Folder selection cancelled.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      reject(new Error(err.trim() || command + " exited with code " + code));
    });
  });
}

async function pickDirectoryNative() {
  if (process.platform === "darwin") {
    const raw = await runCapture("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select Undertwig project folder")',
    ]);
    return path.resolve(raw.replace(/\/+$/, ""));
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
      '$f.Description = "Select Undertwig project folder"',
      "$f.ShowNewFolderButton = $false",
      "if ($f.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }",
      "$f.SelectedPath",
    ].join("; ");
    const raw = await runCapture("powershell.exe", [
      "-NoProfile",
      "-Command",
      script,
    ]);
    return path.resolve(raw);
  }

  const linuxAttempts = [
    ["zenity", ["--file-selection", "--directory", "--title=Select Undertwig project folder"]],
    ["kdialog", ["--getexistingdirectory", os.homedir(), "Select Undertwig project folder"]],
    ["yad", ["--file", "--directory", "--title=Select Undertwig project folder"]],
  ];
  let lastError = null;
  for (const [command, args] of linuxAttempts) {
    try {
      const raw = await runCapture(command, args);
      if (raw) {
        return path.resolve(raw);
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError || new Error(
    "No folder dialog found. Install zenity or kdialog, or use a desktop environment with one of them."
  );
}

function walkProjectFiles(rootDir) {
  const files = [];
  let totalBytes = 0;

  function walk(currentAbs, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (!name || name === "." || name === "..") continue;
      const abs = path.join(currentAbs, name);
      const rel = relBase ? relBase + "/" + name : name;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_IMPORT_FILES) {
        throw new Error(
          "Project has too many files to import (limit " + MAX_IMPORT_FILES + ")."
        );
      }
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (_error) {
        continue;
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_IMPORT_BYTES) {
        throw new Error(
          "Project is too large to import through the local helper (limit 80 MB)."
        );
      }
      const buffer = fs.readFileSync(abs);
      files.push({
        relativePath: rel.replace(/\\/g, "/"),
        name: name,
        base64: buffer.toString("base64"),
      });
    }
  }

  walk(rootDir, "");
  return files;
}

function ensureDirForFile(fileAbs) {
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
}

function writeProjectFiles(rootDir, files) {
  let written = 0;
  for (const file of files || []) {
    const rel = String(file.relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!rel || rel.split("/").some((part) => part === ".." || SKIP_DIR_NAMES.has(part))) {
      continue;
    }
    const abs = path.join(rootDir, ...rel.split("/"));
    ensureDirForFile(abs);
    if (file.binary) {
      fs.writeFileSync(abs, Buffer.from(String(file.content || ""), "base64"));
    } else {
      fs.writeFileSync(abs, String(file.content ?? ""), "utf8");
    }
    written += 1;
  }
  return written;
}

function spawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  return child.pid || true;
}

function openSystemTerminal(cwd) {
  if (process.platform === "darwin") {
    spawnDetached("open", ["-a", "Terminal", cwd]);
    return { launcher: "Terminal.app" };
  }
  if (process.platform === "win32") {
    spawnDetached("cmd.exe", ["/c", "start", "cmd.exe", "/k", "cd /d " + cwd]);
    return { launcher: "cmd.exe" };
  }
  throw new Error("Use tryOpenLinuxTerminal on Linux.");
}

async function tryOpenLinuxTerminal(cwd) {
  const candidates = [
    { cmd: "x-terminal-emulator", args: ["--working-directory=" + cwd] },
    { cmd: "gnome-terminal", args: ["--working-directory=" + cwd] },
    { cmd: "konsole", args: ["--workdir", cwd] },
    { cmd: "xfce4-terminal", args: ["--working-directory=" + cwd] },
    { cmd: "mate-terminal", args: ["--working-directory=" + cwd] },
    { cmd: "tilix", args: ["--working-directory=" + cwd] },
    { cmd: "kitty", args: ["--directory", cwd] },
    { cmd: "alacritty", args: ["--working-directory", cwd] },
    {
      cmd: "xterm",
      args: ["-e", "bash", "-lc", "cd " + JSON.stringify(cwd) + " && exec bash"],
    },
  ];

  for (const item of candidates) {
    const ok = await new Promise((resolve) => {
      const child = spawn(item.cmd, item.args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      let settled = false;
      child.on("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            child.unref();
          } catch (_error) {
            /* ignore */
          }
          resolve(true);
        }
      }, 80);
    });
    if (ok) {
      return { launcher: item.cmd };
    }
  }
  throw new Error(
    "Could not find a terminal emulator on this machine (" + os.platform() + ")."
  );
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      corsPreflight(res);
      return;
    }

    const url = new URL(req.url || "/", "http://" + HOST + ":" + PORT);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      sendJson(res, 200, {
        ok: true,
        service: "undertwig-local-console",
        version: 3,
        port: PORT,
        platform: process.platform,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/path-info") {
      const raw = url.searchParams.get("path") || "";
      try {
        const resolved = path.resolve(String(raw).trim());
        const exists =
          fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
        sendJson(res, 200, {
          ok: true,
          reachable: true,
          exists: exists,
          path: resolved,
          baseName: path.basename(resolved),
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          reachable: true,
          exists: false,
          error: error && error.message ? error.message : String(error),
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/pick-directory") {
      try {
        const picked = await pickDirectoryNative();
        sendJson(res, 200, {
          ok: true,
          path: picked,
          folderName: path.basename(picked),
        });
      } catch (error) {
        const status = error && error.name === "AbortError" ? 400 : 500;
        sendJson(res, status, {
          ok: false,
          cancelled: Boolean(error && error.name === "AbortError"),
          error: error && error.message ? error.message : String(error),
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/import-project") {
      try {
        const picked = await pickDirectoryNative();
        const files = walkProjectFiles(picked);
        sendJson(res, 200, {
          ok: true,
          path: picked,
          folderName: path.basename(picked),
          files: files,
        });
      } catch (error) {
        const status = error && error.name === "AbortError" ? 400 : 500;
        sendJson(res, status, {
          ok: false,
          cancelled: Boolean(error && error.name === "AbortError"),
          error: error && error.message ? error.message : String(error),
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/write-project") {
      const raw = await readBody(req, MAX_WRITE_BODY);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_error) {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }
      try {
        const cwd = resolveExistingDir(body.cwd || body.path);
        const written = writeProjectFiles(cwd, body.files || []);
        sendJson(res, 200, {
          ok: true,
          cwd: cwd,
          written: written,
          folderName: path.basename(cwd),
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/open-terminal") {
      const raw = await readBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_error) {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      let cwd;
      try {
        cwd = resolveExistingDir(body.cwd || body.path);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
        return;
      }

      try {
        const result =
          process.platform === "linux"
            ? await tryOpenLinuxTerminal(cwd)
            : openSystemTerminal(cwd);
        sendJson(res, 200, {
          ok: true,
          cwd: cwd,
          launcher: result.launcher,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[undertwig] Local helper on http://${HOST}:${PORT}\n` +
      `Leave this running for Import project (auto path), Save-to-disk, and Console.`
  );
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(
      `[undertwig] Port ${PORT} is already in use. Is the helper already running?`
    );
  } else {
    console.error("[undertwig] Failed to start helper:", error);
  }
  process.exit(1);
});
