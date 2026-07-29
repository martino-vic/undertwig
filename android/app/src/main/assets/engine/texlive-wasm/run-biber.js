/**
 * Thin browser entry for typeward's Biber WASM (vendored under this folder).
 * Expects `<jobname>.bcf` plus `.bib` sources in `files`.
 *
 * Do not pass a pre-existing `.bbl` as input: typeward omits unchanged
 * inputs from `outputs`, which made successful runs look like failures.
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

function forEachOutput(map, fn) {
  if (!map) {
    return;
  }
  if (typeof map.forEach === "function") {
    map.forEach(fn);
    return;
  }
  Object.keys(map).forEach(function (path) {
    fn(map[path], path);
  });
}

function findJobOutput(outputs, jobname, ext) {
  const exact = jobname + ext;
  const keys = Object.keys(outputs || {});
  return (
    keys.find(function (key) {
      return key === exact || key.endsWith("/" + exact);
    }) ||
    keys.find(function (key) {
      return new RegExp("(?:^|/)" + jobname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\" + ext + "$", "i").test(key);
    }) ||
    null
  );
}

function logSaysWroteBbl(result, jobname) {
  const text = [
    (result && result.stdout) || "",
    (result && result.stderr) || "",
    (result && result.log) || "",
  ].join("\n");
  const escaped = jobname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp("Output to\\s+" + escaped + "\\.bbl", "i").test(text) ||
    new RegExp("Writing '" + escaped + "\\.bbl'", "i").test(text)
  );
}

/**
 * @param {{ jobname?: string, files: Array<{path: string, content: string|Uint8Array}>, timeoutMs?: number }} options
 */
export async function runBiber(options) {
  const jobname = String((options && options.jobname) || "main").replace(/\.bcf$/i, "");
  // Drop any incoming .bbl so a rewritten file is always reported as produced.
  const files = ((options && options.files) || []).filter(function (file) {
    return !/\.bbl$/i.test(String((file && file.path) || ""));
  });
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
    forEachOutput(map, function (bytes, path) {
      const key = String(path || "").replace(/^\.\//, "");
      if (!key) {
        return;
      }
      if (/\.(bbl|blg|bcf|bib)$/i.test(key) || key === jobname + ".bbl" || key === jobname + ".blg") {
        outputs[key] = bytesToText(bytes);
      }
    });

    let bblKey = findJobOutput(outputs, jobname, ".bbl");
    const blgKey = findJobOutput(outputs, jobname, ".blg");

    // Normalize to a stable project-relative key when possible.
    if (bblKey && bblKey !== jobname + ".bbl" && outputs[bblKey] != null) {
      outputs[jobname + ".bbl"] = outputs[bblKey];
      bblKey = jobname + ".bbl";
    }

    const exitOk = Boolean(result && result.exitCode === 0);
    const hasBbl = Boolean(bblKey && outputs[bblKey]);
    const wroteBbl = logSaysWroteBbl(result, jobname);
    const ok = exitOk && (hasBbl || wroteBbl);

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
    if (exitOk && !hasBbl && wroteBbl) {
      logParts.push(
        "",
        "NOTE: Biber reported writing " +
          jobname +
          ".bbl but it was not returned in the WASM output map."
      );
    }

    return {
      ok: ok,
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
