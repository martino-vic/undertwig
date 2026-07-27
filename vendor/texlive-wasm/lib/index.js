import * as Comlink from "./comlink.js";
import { loadManifest, expectedSha256, sha256Hex } from "./manifest.js";
import { c as createBundleFs } from "./bundlefs-CUNRa0dT.js";
import { s as safeRelativePath } from "./paths-FjePC1PO.js";
async function createOpfsFs(opts = {}) {
  const rootName = opts.rootName ?? "texlive-wasm";
  const version = opts.version ?? "unversioned";
  const root = await navigator.storage.getDirectory();
  const tlRoot = await root.getDirectoryHandle(rootName, { create: true });
  const versionRoot = await tlRoot.getDirectoryHandle(safeSegment(version), { create: true });
  const fullDir = await versionRoot.getDirectoryHandle("full", { create: true });
  const cdnDir = await versionRoot.getDirectoryHandle("cdn", { create: true });
  async function walkTo(dir, tdsPath, create) {
    const safe = safeRelativePath(tdsPath);
    if (!safe) return null;
    const parts = safe.split("/");
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        cur = await cur.getDirectoryHandle(parts[i], { create });
      } catch {
        return null;
      }
    }
    return { dir: cur, name: parts[parts.length - 1] };
  }
  async function readFrom(dir, tdsPath) {
    const loc = await walkTo(dir, tdsPath, false);
    if (!loc) return null;
    try {
      const fh = await loc.dir.getFileHandle(loc.name, { create: false });
      const file = await fh.getFile();
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    } catch {
      return null;
    }
  }
  return {
    id: "opfsfs",
    async read(tdsPath) {
      return await readFrom(fullDir, tdsPath) ?? await readFrom(cdnDir, tdsPath);
    },
    async write(tdsPath, bytes) {
      try {
        const loc = await walkTo(cdnDir, tdsPath, true);
        if (!loc) return;
        const fh = await loc.dir.getFileHandle(loc.name, { create: true });
        const writable = await fh.createWritable();
        await writable.write(bytes);
        await writable.close();
      } catch {
      }
    }
  };
}
function safeSegment(name) {
  return name.replace(/[^\w.-]+/g, "_") || "unversioned";
}
function createFetchFs(opts) {
  const base = opts.cdnBaseUrl.endsWith("/") ? opts.cdnBaseUrl : opts.cdnBaseUrl + "/";
  return {
    id: "fetchfs",
    async read(tdsPath) {
      const safePath = safeRelativePath(tdsPath);
      if (!safePath) return null;
      const url = base + safePath.split("/").map(encodeURIComponent).join("/");
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`FETCHFS: HTTP ${r.status} for ${tdsPath}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (opts.verify && !await opts.verify(safePath, buf)) return null;
      await opts.onFetched?.(tdsPath, buf);
      return buf;
    }
  };
}
async function defaultBackends(_id, config, options = {}) {
  const layers = [];
  let manifest = null;
  if (config.manifestUrl) {
    try {
      manifest = await loadManifest(config.manifestUrl);
    } catch (err) {
      console.warn(
        `texlive-wasm: could not load manifest ${config.manifestUrl} (${String(err)}); cached and CDN files will not be integrity-checked`
      );
    }
  }
  const allowUnverified = config.allowUnverifiedAssets === true;
  if (config.cdnBaseUrl && !manifest && !allowUnverified) {
    throw new Error(
      `texlive-wasm: cdnBaseUrl is set but no manifest could be loaded, so CDN files cannot be integrity-checked. Set manifestUrl (its per-file sha256 is what verifies them), or set allowUnverifiedAssets: true for development.`
    );
  }
  if (config.manifestUrl && !options.skipManifestBundle) {
    layers.push(await createBundleFs({ manifestUrl: config.manifestUrl, allowUnverified }));
  }
  let opfs = null;
  if (isOpfsAvailable()) {
    opfs = await createOpfsFs(manifest ? { version: manifest.version } : {});
    layers.push(manifest ? withIntegrity(opfs, manifest) : opfs);
  }
  if (config.cdnBaseUrl) {
    const cache = opfs;
    const index = manifest;
    layers.push(
      createFetchFs({
        cdnBaseUrl: config.cdnBaseUrl,
        // Write-through: CDN hits are persisted into the OPFS cdn/ tier so
        // the next session reads them locally.
        ...cache ? { onFetched: (tdsPath, bytes) => cache.write(tdsPath, bytes) } : {},
        // Verified BEFORE the write-through fires, or a poisoned response
        // would be the thing we cache.
        ...index ? { verify: (tdsPath, bytes) => matches(index, tdsPath, bytes) } : {}
      })
    );
  }
  return layers;
}
function withIntegrity(backend, manifest) {
  const wrapped = {
    id: backend.id,
    async read(tdsPath) {
      const bytes = await backend.read(tdsPath);
      if (!bytes) return null;
      return await matches(manifest, tdsPath, bytes) ? bytes : null;
    }
  };
  if (backend.exists) wrapped.exists = (p) => backend.exists(p);
  if (backend.list) wrapped.list = (p) => backend.list(p);
  if (backend.init) wrapped.init = () => backend.init();
  if (backend.dispose) wrapped.dispose = () => backend.dispose();
  return wrapped;
}
async function matches(manifest, tdsPath, bytes) {
  const expected = expectedSha256(manifest, tdsPath.replace(/^\/+/, ""));
  if (!expected) return true;
  const actual = await sha256Hex(bytes);
  if (actual === expected.toLowerCase()) return true;
  console.warn(
    `texlive-wasm: integrity check failed for ${tdsPath} (expected ${expected}, got ${actual}); discarding those bytes`
  );
  return false;
}
function isOpfsAvailable() {
  return typeof navigator !== "undefined" && typeof navigator.storage !== "undefined" && typeof navigator.storage.getDirectory === "function";
}
const DEFAULT_CONFIG = {
  useWorker: typeof Worker !== "undefined",
  verbose: "silent"
};
const DISPOSE_GRACE_MS = 2e3;
async function createEngine(id, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const bundleInWorker = merged.useWorker === true && !merged.vfs && !!merged.manifestUrl;
  const backends = merged.vfs ?? await defaultBackends(id, merged, { skipManifestBundle: bundleInWorker });
  if (merged.useWorker) {
    return createWorkerEngine(id, merged, backends, bundleInWorker);
  }
  return createInProcessEngine(id);
}
function makeBackendHost(backends) {
  return {
    async read(i, tdsPath) {
      return await backends[i].read(tdsPath) ?? null;
    },
    async exists(i, tdsPath) {
      const b = backends[i];
      if (b.exists) return b.exists(tdsPath);
      return await b.read(tdsPath) != null;
    },
    async list(i, tdsPrefix) {
      const b = backends[i];
      return b.list ? await b.list(tdsPrefix) : [];
    },
    async init(i) {
      await backends[i].init?.();
    },
    async dispose(i) {
      await backends[i].dispose?.();
    }
  };
}
async function createWorkerEngine(id, config, backends, bundleFromManifest = false) {
  const worker = new Worker(new URL(
    /* @vite-ignore */
    "" + new URL("assets/worker-BnpwMuOC.js", import.meta.url).href,
    import.meta.url
  ), {
    type: "module",
    name: "texlive-wasm-worker"
  });
  const workerFailed = new Promise((_, reject) => {
    worker.addEventListener("error", (event) => {
      const msg = event.message || "worker failed to load";
      reject(new Error(`texlive-wasm: engine worker error: ${msg}`));
    });
  });
  const api = Comlink.wrap(worker);
  const { vfs: _vfs, ...cloneableConfig } = config;
  const backendMeta = backends.map((b) => ({
    id: b.id,
    hasList: typeof b.list === "function",
    hasInit: typeof b.init === "function",
    hasDispose: typeof b.dispose === "function"
  }));
  try {
    await Promise.race([
      api.init(
        {
          engineId: id,
          config: cloneableConfig,
          backendMeta,
          ...bundleFromManifest ? { bundleFromManifest: true } : {}
        },
        Comlink.proxy(makeBackendHost(backends))
      ),
      workerFailed
    ]);
  } catch (err) {
    worker.terminate();
    throw err;
  }
  let ready = true;
  let queue = Promise.resolve();
  let killRun = () => {
  };
  const killed = new Promise((_, reject) => {
    killRun = reject;
  });
  killed.catch(() => {
  });
  const terminate = (reason) => {
    ready = false;
    worker.terminate();
    killRun(new Error(`Engine ${id}: ${reason}`));
  };
  const doRun = async (options) => {
    if (!ready) throw new Error(`Engine ${id} has been disposed`);
    const { signal, ...runOptions } = options;
    if (signal?.aborted) throw new Error(`Engine ${id}: run aborted before it started`);
    let timer;
    const onAbort = () => terminate("run aborted; worker terminated");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== void 0) {
      timer = setTimeout(
        () => terminate(`run exceeded timeoutMs=${options.timeoutMs}; worker terminated`),
        options.timeoutMs
      );
    }
    try {
      return await Promise.race([api.run(runOptions), killed]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  return {
    id,
    config,
    async run(options) {
      const result = queue.then(() => doRun(options));
      queue = result.catch(() => {
      });
      return result;
    },
    async dispose() {
      if (!ready) return;
      ready = false;
      try {
        await Promise.race([
          api.dispose(),
          new Promise((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS))
        ]);
      } finally {
        worker.terminate();
        killRun(new Error(`Engine ${id} was disposed while a run was in flight`));
      }
    },
    isReady() {
      return ready;
    }
  };
}
async function createInProcessEngine(id, _config, _backends) {
  throw new Error(
    `texlive-wasm: running ${id} outside a Web Worker (Node / WASI) is not implemented yet. The engines currently require a browser, Tauri WebView, or another Worker-capable host.`
  );
}
function noop() {
}
function createEngineManager(options) {
  const maxLive = Math.max(1, options.maxLiveEngines ?? 3);
  const slots = /* @__PURE__ */ new Map();
  let clock = 0;
  function get(id) {
    const existing = slots.get(id);
    if (existing) {
      existing.lastUsed = ++clock;
      return existing;
    }
    const evicted = evictIdle();
    options.onLoad?.(id);
    const promise = evicted.then(() => createEngine(id, options.config(id)));
    const slot = {
      promise,
      leased: promise.then((handle) => lease(id, handle)),
      current: null,
      pins: 0,
      lastUsed: ++clock
    };
    slots.set(id, slot);
    promise.then((handle) => {
      slot.current = handle;
    }, noop);
    const forget = () => {
      if (slots.get(id) === slot) slots.delete(id);
    };
    promise.catch(forget);
    slot.leased.catch(forget);
    return slot;
  }
  function evictIdle() {
    if (slots.size < maxLive) return Promise.resolve();
    let victim = null;
    let oldest = Infinity;
    for (const [id, slot2] of slots) {
      if (slot2.pins === 0 && slot2.lastUsed < oldest) {
        oldest = slot2.lastUsed;
        victim = id;
      }
    }
    if (!victim) return Promise.resolve();
    const slot = slots.get(victim);
    slots.delete(victim);
    options.onEvict?.(victim);
    return slot.promise.then(
      (h) => h.dispose(),
      () => {
      }
      // a slot that never loaded has nothing to dispose
    );
  }
  function lease(id, handle) {
    return {
      id: handle.id,
      config: handle.config,
      async run(runOptions) {
        const slot = get(id);
        slot.pins++;
        try {
          const live = await slot.promise;
          return await live.run(runOptions);
        } finally {
          slot.pins--;
        }
      },
      // Disposing the worker behind the manager's back would leave the slot
      // handing out a dead handle.
      dispose: () => manager.dispose(id),
      // Answer for the engine the next run() would use, not for the worker
      // this lease was minted around: that one may have been evicted since,
      // and run() would transparently reload it. Reporting the dead worker
      // would have a leased handle claim "not ready" forever after an
      // eviction it is designed to survive.
      isReady: () => slots.get(id)?.current?.isReady() ?? false
    };
  }
  const manager = {
    engine: (id) => get(id).leased,
    async withEngines(ids, fn) {
      const pinned = ids.map((id) => {
        const slot = get(id);
        slot.pins++;
        return slot;
      });
      try {
        const handles = /* @__PURE__ */ new Map();
        for (let i = 0; i < ids.length; i++) {
          handles.set(ids[i], await pinned[i].leased);
        }
        return await fn(handles);
      } finally {
        for (const slot of pinned) slot.pins--;
      }
    },
    live: () => [...slots.keys()],
    async dispose(id) {
      const targets = id ? [id] : [...slots.keys()];
      await Promise.allSettled(
        targets.map((t) => {
          const slot = slots.get(t);
          if (!slot) return Promise.resolve();
          slots.delete(t);
          return slot.promise.then((h) => h.dispose());
        })
      );
    }
  };
  return manager;
}
const DEFAULT_RUN_TIMEOUT_MS = 3e5;
function limitsOf(options) {
  return {
    ...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  };
}
class BaseEngineWrapper {
  constructor(options = {}) {
    this.options = options;
    if (options.engine) this.handle = options.engine;
  }
  handle = null;
  async ensureHandle() {
    if (this.handle) return this.handle;
    const { engine: _ignored, ...config } = this.options;
    this.handle = await createEngine(this.engineId, config);
    return this.handle;
  }
  /** Drop the worker if this wrapper owns one. */
  async dispose() {
    if (this.handle && !this.options.engine) {
      await this.handle.dispose();
      this.handle = null;
    }
  }
  async runRaw(args, files, extra = {}) {
    const handle = await this.ensureHandle();
    const opts = {
      args,
      files,
      cwd: extra.cwd ?? "/project"
    };
    const timeoutMs = extra.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    if (timeoutMs > 0) opts.timeoutMs = timeoutMs;
    if (extra.signal !== void 0) opts.signal = extra.signal;
    if (extra.env !== void 0) opts.env = extra.env;
    return handle.run(opts);
  }
}
class PdfLatex extends BaseEngineWrapper {
  engineId = "pdflatex";
  async compile(options) {
    const args = [
      "--no-shell-escape",
      `--interaction=${options.interaction ?? "nonstopmode"}`,
      ...options.haltOnError !== false ? ["--halt-on-error"] : [],
      `--output-format=${options.outputFormat ?? "pdf"}`,
      ...options.extraArgs ?? [],
      options.mainTex
    ];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
class XeLatex extends BaseEngineWrapper {
  engineId = "xelatex";
  async compile(options) {
    const args = [
      "--no-shell-escape",
      `--interaction=${options.interaction ?? "nonstopmode"}`,
      ...options.haltOnError !== false ? ["--halt-on-error"] : [],
      ...options.noPdf !== false ? ["--no-pdf"] : [],
      ...options.extraArgs ?? [],
      options.mainTex
    ];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
class LuaLatex extends BaseEngineWrapper {
  engineId = "lualatex";
  async compile(options) {
    const args = [
      "--no-shell-escape",
      `--interaction=${options.interaction ?? "nonstopmode"}`,
      ...options.haltOnError !== false ? ["--halt-on-error"] : [],
      ...options.noSocket !== false ? ["--nosocket"] : [],
      ...options.extraArgs ?? [],
      options.mainTex
    ];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
class Bibtexu extends BaseEngineWrapper {
  engineId = "bibtexu";
  async run(options) {
    const args = [...options.extraArgs ?? [], options.auxFile];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
class Biber extends BaseEngineWrapper {
  engineId = "biber";
  async run(options) {
    const jobname = options.jobname.replace(/\.bcf$/i, "");
    const args = ["/biber/bin/biber", "--noconf", ...options.extraArgs ?? [], jobname];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
class Makeindex extends BaseEngineWrapper {
  engineId = "makeindex";
  async run(options) {
    const args = [
      ...options.style ? ["-s", options.style] : [],
      ...options.output ? ["-o", options.output] : [],
      ...options.extraArgs ?? [],
      options.idxFile
    ];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
class Xdvipdfmx extends BaseEngineWrapper {
  engineId = "xdvipdfmx";
  async run(options) {
    const args = ["-o", options.pdf, ...options.extraArgs ?? [], options.xdv];
    return this.runRaw(args, options.files ?? [], limitsOf(options));
  }
}
const RERUN_PATTERNS = [
  /Rerun to get cross-references right/,
  /Rerun to get citations correct/,
  /Label\(s\) may have changed/,
  /No file [^.]+\.toc/,
  /Package rerunfilecheck Warning/,
  // biblatex's generic rerun request (it settles labels/backrefs late).
  /Please rerun LaTeX/,
  /Please \(re\)run Biber/
];
const DEFAULT_MAX_PASSES = 4;
const BIBLATEX_MAX_PASSES = 5;
async function latexmk(opts) {
  const stripExt = (p) => p.replace(/\.tex$/i, "");
  const base = stripExt(opts.mainTex).split("/").pop();
  const auxPath = `${base}.aux`;
  const bcfPath = `${base}.bcf`;
  const idxPath = `${base}.idx`;
  const xdvPath = `${base}.xdv`;
  const pdfPath = `${base}.pdf`;
  const logPath = `${base}.log`;
  const synctexPath = `${base}.synctex.gz`;
  const logs = [];
  const isXetex = opts.engine === "xelatex";
  const biblatexMode = usesBiblatex(opts.files);
  const rerunMode = opts.rerun ?? "auto";
  const maxPasses = rerunMode === false ? 1 : typeof rerunMode === "object" ? Math.max(1, rerunMode.maxPasses) : biblatexMode ? BIBLATEX_MAX_PASSES : DEFAULT_MAX_PASSES;
  const needBibtex = resolveAuto(opts.bibtex, () => detectBibtex(opts.files, biblatexMode));
  const needBiber = !needBibtex && resolveAuto(opts.biber, () => biblatexMode && !biblatexBackendIsBibtex(opts.files));
  const needMakeindex = resolveAuto(opts.makeindex, () => detectMakeindex(opts.files));
  const texExtraArgs = opts.synctex ? ["-synctex=1"] : [];
  let lastAux = null;
  let lastBcf = null;
  let lastIdx = null;
  let pass = 0;
  let exitCode = 0;
  let outputs = /* @__PURE__ */ new Map();
  const materialize = () => {
    const merged = /* @__PURE__ */ new Map();
    for (const f of opts.files) merged.set(f.path.replace(/^\/+/, ""), f);
    for (const [path, content] of outputs) merged.set(path, { path, content });
    return [...merged.values()];
  };
  const tex = buildTexEngine(opts);
  let bibtexWrapper = null;
  let biberWrapper = null;
  let makeindexWrapper = null;
  let xdvipdfmxWrapper = null;
  const pushLog = (cmd, r) => {
    logs.push({ cmd, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, log: r.log });
  };
  const deadline = opts.timeoutMs !== void 0 ? performance.now() + opts.timeoutMs : null;
  const budget = () => {
    const limits = {};
    if (opts.signal) limits.signal = opts.signal;
    if (deadline !== null) {
      const left = Math.ceil(deadline - performance.now());
      if (left <= 0) {
        throw new Error(`latexmk: pipeline exceeded timeoutMs=${opts.timeoutMs}`);
      }
      limits.timeoutMs = left;
    }
    return limits;
  };
  try {
    while (pass < maxPasses) {
      pass++;
      const result2 = await tex.compile({
        mainTex: opts.mainTex,
        files: pass === 1 ? opts.files : materialize(),
        extraArgs: texExtraArgs,
        ...budget(),
        // XeTeX in WASM cannot spawn xdvipdfmx itself (no popen); we always
        // hold the .xdv and finalize with our own xdvipdfmx pass below.
        ...isXetex ? { noPdf: true } : {}
      });
      pushLog(`${opts.engine} ${opts.mainTex}`, result2);
      exitCode = result2.exitCode;
      outputs = mergeOutputs(outputs, result2.outputs);
      if (exitCode !== 0) break;
      let helpersRan = false;
      if (pass === 1 && needBibtex && outputs.has(auxPath)) {
        bibtexWrapper ??= new Bibtexu(wrapperConfig(opts, "bibtexu", opts.handles?.bibtex));
        const r = await bibtexWrapper.run({
          auxFile: auxPath,
          files: materialize(),
          ...budget(),
          // biblatex's aux needs bibtex8's "wolfgang" capacity mode; the
          // switch is harmless for classic .bst documents but only biblatex
          // requires it, so keep classic invocations byte-identical.
          ...biblatexMode ? { extraArgs: ["--wolfgang"] } : {}
        });
        pushLog(`bibtexu ${auxPath}`, r);
        outputs = mergeOutputs(outputs, r.outputs);
        if (r.exitCode >= 2) {
          exitCode = r.exitCode;
          break;
        }
        helpersRan = true;
      }
      if (needBiber && outputs.has(bcfPath)) {
        const bcfNow = bytesToString(outputs.get(bcfPath));
        if (bcfNow !== lastBcf) {
          lastBcf = bcfNow;
          biberWrapper ??= new Biber(wrapperConfig(opts, "biber", opts.handles?.biber));
          const r = await biberWrapper.run({ jobname: base, files: materialize(), ...budget() });
          pushLog(`biber ${base}`, r);
          outputs = mergeOutputs(outputs, r.outputs);
          if (r.exitCode >= 2) {
            exitCode = r.exitCode;
            break;
          }
          helpersRan = true;
        }
      }
      if (needMakeindex && outputs.has(idxPath)) {
        const idxNow = bytesToString(outputs.get(idxPath));
        if (idxNow !== lastIdx) {
          lastIdx = idxNow;
          makeindexWrapper ??= new Makeindex(
            wrapperConfig(opts, "makeindex", opts.handles?.makeindex)
          );
          const r = await makeindexWrapper.run({
            idxFile: idxPath,
            files: materialize(),
            ...budget()
          });
          pushLog(`makeindex ${idxPath}`, r);
          outputs = mergeOutputs(outputs, r.outputs);
          if (r.exitCode !== 0) {
            exitCode = r.exitCode;
            break;
          }
          helpersRan = true;
        }
      }
      if (pass >= maxPasses) break;
      const aux = bytesToString(outputs.get(auxPath));
      const log = bytesToString(outputs.get(logPath));
      const rerunRequested = RERUN_PATTERNS.some((re) => re.test(log));
      const auxStable = lastAux !== null && aux === lastAux;
      lastAux = aux;
      if (helpersRan) continue;
      if (auxStable && !rerunRequested) break;
    }
    if (isXetex && exitCode === 0 && outputs.has(xdvPath)) {
      xdvipdfmxWrapper ??= new Xdvipdfmx(wrapperConfig(opts, "xdvipdfmx", opts.handles?.xdvipdfmx));
      const r = await xdvipdfmxWrapper.run({
        xdv: xdvPath,
        pdf: pdfPath,
        files: materialize(),
        ...budget()
      });
      pushLog(`xdvipdfmx -o ${pdfPath} ${xdvPath}`, r);
      outputs = mergeOutputs(outputs, r.outputs);
      if (r.exitCode !== 0) exitCode = r.exitCode;
    }
  } finally {
    await Promise.allSettled(
      [tex, bibtexWrapper, biberWrapper, makeindexWrapper, xdvipdfmxWrapper].filter((w) => w !== null).map((w) => w.dispose())
    );
  }
  const result = {
    success: exitCode === 0 && outputs.has(pdfPath),
    log: bytesToString(outputs.get(logPath)),
    logs,
    exitCode,
    passes: pass
  };
  const pdf = outputs.get(pdfPath);
  if (pdf) result.pdf = pdf;
  const synctex = outputs.get(synctexPath);
  if (synctex) result.synctex = synctex;
  return result;
}
function resolveAuto(value, autoFn) {
  if (value === true) return true;
  if (value === false) return false;
  return autoFn();
}
function contentToString(content) {
  if (typeof content === "string") return content;
  return new TextDecoder("utf-8", { fatal: false }).decode(content);
}
const BIBLATEX_LOAD = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{\s*biblatex\s*\}/;
const BIBLATEX_PASS_OPTS = /\\PassOptionsToPackage\s*\{([^}]*)\}\s*\{\s*biblatex\s*\}/;
const BACKEND_BIBTEX = /backend\s*=\s*bibtex8?\s*(?:[,\]}]|$)/m;
function usesBiblatex(files) {
  return files.some((f) => BIBLATEX_LOAD.test(contentToString(f.content)));
}
function biblatexBackendIsBibtex(files) {
  return files.some((f) => {
    const text = contentToString(f.content);
    const load = BIBLATEX_LOAD.exec(text);
    if (load?.[1] && BACKEND_BIBTEX.test(load[1])) return true;
    const pass = BIBLATEX_PASS_OPTS.exec(text);
    return pass?.[1] !== void 0 && BACKEND_BIBTEX.test(pass[1]);
  });
}
function willRunBibtex(files) {
  return detectBibtex(files, usesBiblatex(files));
}
function willRunBiber(files) {
  return usesBiblatex(files) && !biblatexBackendIsBibtex(files);
}
function detectBibtex(files, biblatexMode) {
  if (biblatexMode) return biblatexBackendIsBibtex(files);
  return files.some((f) => contentToString(f.content).includes("\\bibliography{"));
}
function detectMakeindex(files) {
  return files.some((f) => {
    const text = contentToString(f.content);
    return text.includes("\\makeindex") || text.includes("\\printindex");
  });
}
function bytesToString(bytes) {
  if (!bytes) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
function mergeOutputs(base, add) {
  for (const [k, v] of add) base.set(k, v);
  return base;
}
function wrapperConfig(opts, id, handle) {
  if (handle) return { engine: handle };
  const config = typeof opts.engineConfig === "function" ? opts.engineConfig(id) : opts.engineConfig ?? {};
  const { useWorker: _useWorker, ...wrapperSafe } = config;
  return {
    ...wrapperSafe,
    ...opts.verbose ? { verbose: opts.verbose } : {}
  };
}
function buildTexEngine(opts) {
  const config = wrapperConfig(opts, opts.engine, opts.handles?.tex);
  if (opts.engine === "pdflatex") return new PdfLatex(config);
  if (opts.engine === "xelatex") return new XeLatex(config);
  return new LuaLatex(config);
}
function strFromU8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}
async function gunzip(bytes) {
  const Ctor = globalThis.DecompressionStream;
  if (!Ctor) {
    throw new Error(
      "DecompressionStream is not available; ship a gzip polyfill or upgrade Node/browser."
    );
  }
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const stream = new Blob([ab]).stream().pipeThrough(new Ctor("gzip"));
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}
async function createSynctex(bytes) {
  const decompressed = isGzip(bytes) ? await gunzip(bytes) : bytes;
  const text = strFromU8(decompressed);
  const parsed = parseSynctex(text);
  return {
    forward(_file, _line, _column) {
      return [];
    },
    reverse(_page, _x, _y) {
      return [];
    },
    files() {
      return Object.values(parsed.inputs);
    }
  };
}
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139;
}
function parseSynctex(text) {
  const inputs = {};
  const records = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("Input:")) {
      const rest = line.slice("Input:".length);
      const colon = rest.indexOf(":");
      if (colon > 0) {
        const id = rest.slice(0, colon);
        const name = rest.slice(colon + 1);
        inputs[id] = name;
      }
    } else if (line.length > 0) {
      records.push(line);
    }
  }
  return { inputs, records };
}
export {
  Biber,
  Bibtexu,
  DEFAULT_RUN_TIMEOUT_MS,
  LuaLatex,
  Makeindex,
  PdfLatex,
  Xdvipdfmx,
  XeLatex,
  createBundleFs,
  createEngine,
  createEngineManager,
  createFetchFs,
  createOpfsFs,
  createSynctex,
  defaultBackends,
  expectedSha256,
  latexmk,
  loadManifest,
  sha256Hex,
  willRunBiber,
  willRunBibtex,
  withIntegrity
};
