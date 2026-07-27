(function (global) {
  const ENGINE_STORAGE_KEY = "undertwig-latex-engine-v1";
  const PDF = "pdflatex";
  const LUA = "lualatex";
  const LABELS = {
    pdflatex: "pdfLaTeX",
    lualatex: "LuaLaTeX",
  };
  const BUSYTEX_CDN = "https://texlyre.github.io/texlyre-busytex/core/busytex";
  const BUSYTEX_WORKER = "vendor/busytex/busytex_worker.js";
  const TEXLIVE_REMOTE = "https://texlive.texlyre.org/";

  let selectedEngine = readStoredEngine();
  let luaWorker = null;
  let luaReady = false;
  let luaInitPromise = null;

  function readStoredEngine() {
    try {
      const value = String(localStorage.getItem(ENGINE_STORAGE_KEY) || "").trim();
      if (value === LUA || value === PDF) {
        return value;
      }
    } catch (_error) {
      // Ignore.
    }
    return PDF;
  }

  function persistEngine(id) {
    try {
      localStorage.setItem(ENGINE_STORAGE_KEY, id);
    } catch (_error) {
      // Ignore.
    }
  }

  function getSelectedEngine() {
    return selectedEngine;
  }

  function getSelectedEngineLabel() {
    return LABELS[selectedEngine] || LABELS.pdflatex;
  }

  function setSelectedEngine(id) {
    const next = id === LUA ? LUA : PDF;
    if (selectedEngine === next) {
      return selectedEngine;
    }
    selectedEngine = next;
    persistEngine(selectedEngine);
    if (selectedEngine !== LUA) {
      closeLuaWorker();
    }
    return selectedEngine;
  }

  function listEngines() {
    return [
      { id: PDF, label: LABELS.pdflatex },
      { id: LUA, label: LABELS.lualatex },
    ];
  }

  function closeLuaWorker() {
    if (luaWorker) {
      try {
        luaWorker.terminate();
      } catch (_error) {
        // Ignore.
      }
    }
    luaWorker = null;
    luaReady = false;
    luaInitPromise = null;
  }

  function ensureLuaWorker(onProgress) {
    if (luaReady && luaWorker) {
      return Promise.resolve();
    }
    if (luaInitPromise) {
      return luaInitPromise;
    }

    luaInitPromise = new Promise(function (resolve, reject) {
      closeLuaWorker();
      try {
        luaWorker = new Worker(BUSYTEX_WORKER);
      } catch (error) {
        luaInitPromise = null;
        reject(error);
        return;
      }

      let settled = false;
      const timeout = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        closeLuaWorker();
        reject(
          new Error(
            "LuaLaTeX engine timed out while downloading. Check your connection and try again."
          )
        );
      }, 300000);

      const finish = function (fn) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      luaWorker.onmessage = function (event) {
        const data = event && event.data ? event.data : {};
        if (data.print && typeof onProgress === "function") {
          onProgress(String(data.print));
        }
        if (data.initialized) {
          finish(function () {
            luaReady = true;
            resolve();
          });
          return;
        }
        if (data.exception) {
          finish(function () {
            closeLuaWorker();
            reject(new Error(String(data.exception)));
          });
        }
      };

      luaWorker.onerror = function (error) {
        finish(function () {
          closeLuaWorker();
          reject(
            new Error(
              (error && error.message) ||
                "Could not start the LuaLaTeX Web Worker."
            )
          );
        });
      };

      luaWorker.postMessage({
        busytex_js: BUSYTEX_CDN + "/busytex.js",
        busytex_wasm: BUSYTEX_CDN + "/busytex.wasm",
        preload_data_packages_js: [
          BUSYTEX_CDN + "/texlive-basic.js",
          BUSYTEX_CDN + "/texlive-recommended.js",
        ],
        data_packages_js: [],
        texmf_local: [],
        preload: true,
      });
    }).catch(function (error) {
      luaInitPromise = null;
      throw error;
    });

    return luaInitPromise;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function projectFilesToBusyTex(projectFiles) {
    return Object.keys(projectFiles || {})
      .sort()
      .map(function (path) {
        const file = projectFiles[path];
        let contents = "";
        if (file && file.binary) {
          contents = base64ToBytes(file.content);
        } else {
          contents = file && file.content != null ? file.content : "";
        }
        return { path: path, contents: contents };
      });
  }

  function compileWithPdfLaTeX(projectFiles, options) {
    const notify = options && options.onProgress ? options.onProgress : function () {};
    const PdfTeXEngine = global.PdfTeXEngine;
    if (typeof PdfTeXEngine !== "function") {
      return Promise.reject(new Error("pdfLaTeX engine is not loaded."));
    }

    let engine = null;
    return (async function () {
      notify("Loading pdfLaTeX (PdfTeX)…");
      if (options && options.previousEngine && options.previousEngine.closeWorker) {
        try {
          options.previousEngine.closeWorker();
        } catch (_error) {
          // Ignore.
        }
      }
      engine = new PdfTeXEngine();
      await engine.loadEngine();

      const folders = new Set();
      Object.keys(projectFiles).forEach(function (path) {
        const parts = path.split("/");
        parts.pop();
        let current = "";
        parts.forEach(function (part) {
          current = current ? current + "/" + part : part;
          folders.add(current);
        });
      });
      Array.from(folders)
        .sort(function (a, b) {
          return a.split("/").length - b.split("/").length;
        })
        .forEach(function (folder) {
          engine.makeMemFSFolder(folder);
        });

      Object.keys(projectFiles).forEach(function (path) {
        const file = projectFiles[path];
        const content = file.binary ? base64ToBytes(file.content) : file.content;
        engine.writeMemFSFile(path, content);
      });

      engine.setEngineMainFile("main.tex");
      let result = null;
      let auxFiles = {};
      for (let pass = 1; pass <= 2; pass += 1) {
        notify("Converting with pdfLaTeX (pass " + pass + "/2)…");
        Object.keys(auxFiles).forEach(function (path) {
          engine.writeMemFSFile(path, auxFiles[path]);
        });
        result = await engine.compileLaTeX();
        if (result && result.aux && typeof result.aux === "object") {
          auxFiles = result.aux;
        }
        if (!result || result.status !== 0 || !result.pdf) {
          break;
        }
      }

      return {
        ok: Boolean(result && result.status === 0 && result.pdf),
        pdf: result && result.pdf,
        log: (result && result.log) || "No compiler log returned.",
        engine: engine,
        label: LABELS.pdflatex,
      };
    })();
  }

  function compileWithLuaLaTeX(projectFiles, options) {
    const notify = options && options.onProgress ? options.onProgress : function () {};

    return ensureLuaWorker(function (message) {
      const text = String(message || "");
      if (/Preparing|Downloading|complete/i.test(text)) {
        notify("Downloading LuaLaTeX assets… " + text);
      } else {
        notify(text);
      }
    }).then(function () {
      notify("Converting with LuaLaTeX…");
      const files = projectFilesToBusyTex(projectFiles);
      return new Promise(function (resolve, reject) {
        if (!luaWorker) {
          reject(new Error("LuaLaTeX worker is not ready."));
          return;
        }

        const timeout = setTimeout(function () {
          reject(new Error("LuaLaTeX compilation timed out."));
        }, 300000);

        luaWorker.onmessage = function (event) {
          const data = event && event.data ? event.data : {};
          if (data.print && typeof notify === "function") {
            notify(String(data.print));
          }
          if (data.pdf !== undefined) {
            clearTimeout(timeout);
            resolve({
              ok: data.exit_code === 0 && Boolean(data.pdf),
              pdf: data.pdf,
              log: data.log || "No compiler log returned.",
              engine: null,
              label: LABELS.lualatex,
            });
            return;
          }
          if (data.exception) {
            clearTimeout(timeout);
            reject(new Error(String(data.exception)));
          }
        };

        luaWorker.onerror = function (error) {
          clearTimeout(timeout);
          reject(
            new Error((error && error.message) || "LuaLaTeX worker failed during compile.")
          );
        };

        luaWorker.postMessage({
          files: files,
          main_tex_path: "main.tex",
          bibtex: null,
          makeindex: null,
          rerun: true,
          verbose: "silent",
          driver: "luahbtex_bibtex8",
          data_packages_js: null,
          remote_endpoint: TEXLIVE_REMOTE,
          shell_escape: false,
        });
      });
    });
  }

  function compileProjectFiles(projectFiles, options) {
    if (selectedEngine === LUA) {
      return compileWithLuaLaTeX(projectFiles, options || {});
    }
    return compileWithPdfLaTeX(projectFiles, options || {});
  }

  global.UndertwigEngines = {
    PDF: PDF,
    LUA: LUA,
    LABELS: LABELS,
    getSelectedEngine: getSelectedEngine,
    getSelectedEngineLabel: getSelectedEngineLabel,
    setSelectedEngine: setSelectedEngine,
    listEngines: listEngines,
    compileProjectFiles: compileProjectFiles,
    closeLuaWorker: closeLuaWorker,
  };
})(window);
