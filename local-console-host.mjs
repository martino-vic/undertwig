#!/usr/bin/env node
/**
 * Undertwig local console host (desktop offline helper).
 *
 * Binds 127.0.0.1 only and runs shell commands in a cwd chosen by the browser.
 * Start from any directory:
 *
 *   node local-console-host.mjs
 *
 * The undertwig.com / local site Console panel talks to this process.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.UNDERTWIG_CONSOLE_PORT || 17834);
const MAX_OUTPUT = 400_000;
const DEFAULT_TIMEOUT_MS = 60_000;

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

function sendText(res, status, text) {
  const payload = String(text || "");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
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
      if (size > 1_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function resolveCwd(cwd) {
  const raw = String(cwd || "").trim();
  if (!raw) {
    throw new Error("Missing cwd. Set the working directory in the Console bar.");
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("cwd is not an existing directory: " + resolved);
  }
  return resolved;
}

function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch (_error) {
        /* ignore */
      }
      resolve({
        ok: false,
        exitCode: null,
        signal: "timeout",
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: (stderr + "\n[undertwig] command timed out").slice(0, MAX_OUTPUT),
      });
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += buf.toString("utf8");
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT) + "\n…[truncated]";
        }
      }
    });
    child.stderr.on("data", (buf) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += buf.toString("utf8");
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT) + "\n…[truncated]";
        }
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout,
        stderr: String(error && error.message ? error.message : error),
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        signal: signal || null,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
      });
    });
  });
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
        version: 1,
        port: PORT,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      const raw = await readBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch (_error) {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }
      const command = String(body.command || "").trim();
      if (!command) {
        sendJson(res, 400, { ok: false, error: "Missing command" });
        return;
      }
      if (command.length > 8000) {
        sendJson(res, 400, { ok: false, error: "Command too long" });
        return;
      }
      let cwd;
      try {
        cwd = resolveCwd(body.cwd);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
        return;
      }
      const timeoutMs = Math.min(
        Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
        300000
      );
      const result = await runCommand(command, cwd, timeoutMs);
      sendJson(res, 200, {
        ok: result.ok,
        cwd,
        command,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return;
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[undertwig] Local console host on http://${HOST}:${PORT}\n` +
      `Leave this running, then open Console in Undertwig (desktop, logged out).\n` +
      `Set cwd in the Console bar to your project folder path.`
  );
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(
      `[undertwig] Port ${PORT} is already in use. Is the console host already running?`
    );
  } else {
    console.error("[undertwig] Failed to start console host:", error);
  }
  process.exit(1);
});
