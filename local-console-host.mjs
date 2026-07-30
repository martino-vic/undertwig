#!/usr/bin/env node
/**
 * Undertwig local helper — opens your system terminal at a project path.
 *
 *   node local-console-host.mjs
 *
 * Binds 127.0.0.1 only. Used by the desktop Console button when logged out.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const HOST = "127.0.0.1";
const PORT = Number(process.env.UNDERTWIG_CONSOLE_PORT || 17834);

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 200_000) {
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
  const platform = process.platform;

  if (platform === "darwin") {
    // Opens Terminal.app with cwd as the working directory.
    spawnDetached("open", ["-a", "Terminal", cwd]);
    return { launcher: "Terminal.app" };
  }

  if (platform === "win32") {
    spawnDetached("cmd.exe", ["/c", "start", "cmd.exe", "/k", "cd /d " + cwd]);
    return { launcher: "cmd.exe" };
  }

  const linuxLaunchers = [
    ["x-terminal-emulator", ["--working-directory=" + cwd]],
    ["gnome-terminal", ["--working-directory=" + cwd]],
    ["konsole", ["--workdir", cwd]],
    ["xfce4-terminal", ["--working-directory=" + cwd]],
    ["mate-terminal", ["--working-directory=" + cwd]],
    ["tilix", ["--working-directory=" + cwd]],
    ["kitty", ["--directory", cwd]],
    ["alacritty", ["--working-directory", cwd]],
    ["xterm", ["-e", "bash", "-lc", "cd " + JSON.stringify(cwd) + " && exec bash"]],
  ];

  const errors = [];
  for (const [command, args] of linuxLaunchers) {
    try {
      spawnDetached(command, args);
      return { launcher: command };
    } catch (error) {
      errors.push(command + ": " + (error && error.message ? error.message : error));
    }
  }

  // spawn doesn't throw if binary missing — check via which-like attempt
  for (const [command, args] of linuxLaunchers) {
    try {
      const probe = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      probe.unref();
      let failed = false;
      probe.on("error", () => {
        failed = true;
      });
      // If error fires synchronously we're fine; otherwise assume launched.
      if (!failed) {
        return { launcher: command };
      }
    } catch (error) {
      errors.push(command + ": " + (error && error.message ? error.message : error));
    }
  }

  throw new Error(
    "Could not find a terminal emulator. Tried: " +
      linuxLaunchers.map((pair) => pair[0]).join(", ")
  );
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
      // Give the process a tick to fail on ENOENT.
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
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://" + HOST + ":" + PORT);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      sendJson(res, 200, {
        ok: true,
        service: "undertwig-local-console",
        version: 2,
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
        let result;
        if (process.platform === "linux") {
          result = await tryOpenLinuxTerminal(cwd);
        } else {
          result = openSystemTerminal(cwd);
        }
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
      `Leave this running. On undertwig (desktop, logged out), Console opens your system terminal in the Work desk project folder.`
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
