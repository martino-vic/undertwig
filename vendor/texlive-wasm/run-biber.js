/**
 * Thin browser entry for typeward's Biber WASM (vendored under this folder).
 * Expects `<jobname>.bcf` plus `.bib` sources in `files`.
 */
import { Biber } from "./lib/index.js";

const ENGINE_PATH = new URL("biber/emscripten/biber.wasm", import.meta.url).href;
const BUNDLE_URL = new URL("biber/emscripten/biber-vfs.tar.gz", import.meta.url).href;

function bytesToText(bytes) {
  if (typeof bytes === "string") {
    return bytes;
  }
  if (!bytes) {
    return "";
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * @param {{ jobname?: string, files: Array<{path: string, content: string|Uint8Array}>, timeoutMs?: number }} options
 */
export async function runBiber(options) {
  const jobname = String((options && options.jobname) || "main").replace(/\.bcf$/i, "");
  const files = (options && options.files) || [];
  const timeoutMs =
    options && typeof options.timeoutMs === "number" ? options.timeoutMs : 300000;

  const biber = new Biber({
    enginePath: ENGINE_PATH,
    bundleUrl: BUNDLE_URL,
    useWorker: true,
    verbose: "silent",
  });

  try {
    const result = await biber.run({
      jobname: jobname,
      files: files,
      timeoutMs: timeoutMs,
    });

    const outputs = {};
    const map = result && result.outputs ? result.outputs : new Map();
    map.forEach(function (bytes, path) {
      const key = String(path || "").replace(/^\.\//, "");
      if (!key) {
        return;
      }
      if (/\.(bbl|blg|bcf|bib)$/i.test(key) || key === jobname + ".bbl" || key === jobname + ".blg") {
        outputs[key] = bytesToText(bytes);
      }
    });

    // Prefer explicit job outputs even if the Map keys differ slightly.
    const bblKey = Object.keys(outputs).find(function (key) {
      return key === jobname + ".bbl" || key.endsWith("/" + jobname + ".bbl");
    });
    const blgKey = Object.keys(outputs).find(function (key) {
      return key === jobname + ".blg" || key.endsWith("/" + jobname + ".blg");
    });

    const logParts = [
      "$ biber --noconf " + jobname,
      "EXITCODE: " + (result ? result.exitCode : 1),
      "DURATION_MS: " + (result ? result.durationMs : 0),
      "",
      "STDOUT:",
      (result && result.stdout) || "",
      "==",
      "STDERR:",
      (result && result.stderr) || "",
      "======",
    ];
    if (result && result.log) {
      logParts.push("", "LOG:", result.log);
    }
    if (blgKey) {
      logParts.push("", "BLG:", outputs[blgKey]);
    }

    return {
      ok: Boolean(result && result.exitCode === 0 && bblKey && outputs[bblKey]),
      exit_code: result ? result.exitCode : 1,
      tool: "biber",
      log: logParts.join("\n"),
      outputs: outputs,
    };
  } finally {
    try {
      await biber.dispose();
    } catch (_error) {
      // Ignore dispose failures.
    }
  }
}
