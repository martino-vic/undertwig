/* Undertwig Android: BibTeX path (same role as desktop "Update Bibliography"). */
(function (global) {
  "use strict";

  var BUSYTEX_DIR = new URL("./busytex/", global.location.href).href.replace(/\/?$/, "/");
  var BUSYTEX_WORKER = BUSYTEX_DIR + "busytex_worker.js?v=1";
  var BUSYTEX_TEXLIVE = "https://texlyre.github.io/texlyre-busytex/core/busytex";
  var TEXLIVE_REMOTE = "https://texlive2026.texlyre.org/";

  var luaWorker = null;
  var luaReady = false;
  var luaInitPromise = null;

  function base64ToBytes(b64) {
    var binary = atob(b64);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function closeLuaWorker() {
    if (luaWorker) {
      try {
        luaWorker.terminate();
      } catch (_e) {}
    }
    luaWorker = null;
    luaReady = false;
    luaInitPromise = null;
  }

  function findMainAux(projectFiles) {
    var keys = Object.keys(projectFiles || {});
    return (
      keys.find(function (path) {
        return path === "main.aux" || /(^|\/)main\.aux$/i.test(path);
      }) || null
    );
  }

  function readMainTexContent(projectFiles) {
    var file = projectFiles && projectFiles["main.tex"];
    if (!file || file.binary || file.content == null) {
      return "";
    }
    return String(file.content);
  }

  function projectUsesHandwrittenBibliography(projectFiles) {
    var content = readMainTexContent(projectFiles);
    return (
      /\\begin\{thebibliography\}/.test(content) &&
      !/\\bibliography\s*\{/.test(content) &&
      !/\\addbibresource\s*\{/.test(content)
    );
  }

  function auxHasBibtexHooks(projectFiles) {
    var auxPath = findMainAux(projectFiles);
    if (!auxPath) {
      return false;
    }
    var file = projectFiles[auxPath];
    var content = file && file.content != null ? String(file.content) : "";
    return /\\bibdata\s*\{/.test(content) && /\\bibstyle\s*\{/.test(content);
  }

  function mergeAuxIntoProjectFiles(projectFiles, auxFiles) {
    var next = Object.assign({}, projectFiles || {});
    Object.keys(auxFiles || {}).forEach(function (path) {
      var key = String(path).replace(/^\/+/, "");
      if (!key || auxFiles[path] == null) {
        return;
      }
      next[key] = {
        content: String(auxFiles[path]),
        binary: false,
      };
    });
    return next;
  }

  function projectFilesToBusyTex(projectFiles) {
    return Object.keys(projectFiles || {})
      .sort()
      .map(function (path) {
        var file = projectFiles[path];
        var contents = "";
        if (file && file.binary) {
          contents = base64ToBytes(file.content);
        } else {
          contents = file && file.content != null ? file.content : "";
        }
        return { path: path, contents: contents };
      });
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

      var settled = false;
      var timeout = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        closeLuaWorker();
        reject(
          new Error(
            "BibTeX engine timed out while downloading. Check your connection and try again."
          )
        );
      }, 300000);

      var finish = function (fn) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      luaWorker.onmessage = function (event) {
        var data = event && event.data ? event.data : {};
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
              (error && error.message) || "Could not start the BibTeX Web Worker."
            )
          );
        });
      };

      luaWorker.postMessage({
        busytex_js: BUSYTEX_DIR + "busytex.js",
        busytex_wasm: BUSYTEX_DIR + "busytex.wasm",
        preload_data_packages_js: [
          BUSYTEX_TEXLIVE + "/texlive-basic.js",
          BUSYTEX_TEXLIVE + "/texlive-recommended.js",
          BUSYTEX_TEXLIVE + "/texlive-extra.js",
        ],
        data_packages_js: [],
        texmf_local: [],
        preload: true,
        remote_endpoint: TEXLIVE_REMOTE,
      });
    }).catch(function (error) {
      luaInitPromise = null;
      throw error;
    });

    return luaInitPromise;
  }

  function postBibToolToWorker(files, tool, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!luaWorker) {
        reject(new Error("Bibliography worker is not ready."));
        return;
      }

      var settled = false;
      var timeout = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        closeLuaWorker();
        reject(
          new Error(
            "Bibliography helper timed out. Convert once, then try Bib again."
          )
        );
      }, 120000);

      var finish = function (fn) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      luaWorker.onmessage = function (event) {
        var data = event && event.data ? event.data : {};
        if (data.print && typeof onProgress === "function") {
          onProgress(String(data.print));
        }
        if (data.tool) {
          finish(function () {
            resolve(data);
          });
          return;
        }
        if (data.exception) {
          finish(function () {
            reject(new Error(String(data.exception)));
          });
        }
      };

      luaWorker.onerror = function (error) {
        finish(function () {
          reject(
            new Error((error && error.message) || "Bibliography worker failed.")
          );
        });
      };

      luaWorker.postMessage({
        run_bibtool: true,
        bib_tool: tool || "bibtex",
        files: files,
        main_tex_path: "main.tex",
        main_job_path: "main.tex",
      });
    });
  }

  function bytesToBase64(bytes) {
    var binary = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, Math.min(i + chunk, bytes.length))
      );
    }
    return btoa(binary);
  }

  function normalizeTextOutputs(outputs) {
    var textOutputs = {};
    Object.keys(outputs || {}).forEach(function (path) {
      var value = outputs[path];
      if (value == null) {
        return;
      }
      if (typeof value === "string") {
        textOutputs[path] = value;
      } else if (value instanceof Uint8Array) {
        textOutputs[path] = new TextDecoder("utf-8", { fatal: false }).decode(value);
      } else {
        textOutputs[path] = String(value);
      }
    });
    return textOutputs;
  }

  function projectFilesToTypeward(projectFiles) {
    return Object.keys(projectFiles || {})
      .sort()
      .map(function (path) {
        var file = projectFiles[path];
        var content = "";
        if (file && file.binary) {
          content = base64ToBytes(file.content);
        } else {
          content = file && file.content != null ? String(file.content) : "";
        }
        return { path: path, content: content };
      });
  }

  function mergePreparedOutputs(projectFiles, outputs) {
    var next = Object.assign({}, projectFiles || {});
    Object.keys(outputs || {}).forEach(function (path) {
      var key = String(path).replace(/^\/+/, "");
      if (!key || outputs[path] == null) {
        return;
      }
      next[key] = {
        content: String(outputs[path]),
        binary: false,
      };
    });
    return next;
  }

  async function runTypewardBiber(projectFiles, notify) {
    notify("Loading Biber WASM…");
    var moduleUrl = new URL("./texlive-wasm/run-biber.js?v=10", global.location.href).href;
    var mod = await import(moduleUrl);
    if (!mod || typeof mod.runBiber !== "function") {
      throw new Error("Biber WASM module failed to load.");
    }
    notify("Running Biber…");
    var result = await mod.runBiber({
      jobname: "main",
      files: projectFilesToTypeward(projectFiles),
      timeoutMs: 300000,
    });
    var outputs = normalizeTextOutputs((result && result.outputs) || {});
    var hasBbl = Object.keys(outputs).some(function (path) {
      return /\.bbl$/i.test(path) && String(outputs[path] || "").trim();
    });
    return {
      ok: Boolean(result && (result.ok || result.exit_code === 0) && hasBbl),
      log: (result && result.log) || "No Biber log returned.",
      outputs: outputs,
    };
  }

  async function runBibTeX(projectFiles, notify) {
    notify("Bibliography (1/3): Preparing citation data");
    var auxResult = await ensureBibtexAux(projectFiles, notify);

    notify("Bibliography (2/3): Loading BibTeX engine");
    await ensureLuaWorker(function (message) {
      var text = String(message || "").replace(/\s+/g, " ").trim();
      if (
        text &&
        (/Preparing|Downloading|Fetching|complete|texlive|wasm|package/i.test(text) ||
          text.length < 100)
      ) {
        notify("Bibliography (2/3): Loading BibTeX engine — " + text);
      }
    });

    notify("Bibliography (3/3): Running BibTeX");
    var files = projectFilesToBusyTex(auxResult.files);
    var data = await postBibToolToWorker(files, "bibtex", function (message) {
      var text = String(message || "").replace(/\s+/g, " ").trim();
      if (text) {
        notify("Bibliography (3/3): Running BibTeX — " + text);
      }
    });

    var outputs = Object.assign({}, data.outputs || {});
    if (auxResult.wroteAux && auxResult.aux) {
      Object.keys(auxResult.aux).forEach(function (path) {
        var key = String(path).replace(/^\/+/, "");
        if (key && outputs[key] == null && auxResult.aux[path] != null) {
          outputs[key] = String(auxResult.aux[path]);
        }
      });
    }

    var textOutputs = normalizeTextOutputs(outputs);
    var hasBbl = Object.keys(textOutputs).some(function (path) {
      return /\.bbl$/i.test(path) && String(textOutputs[path] || "").trim();
    });

    return {
      ok: Boolean(data.ok) || hasBbl,
      log: data.log || "No bibliography log returned.",
      outputs: textOutputs,
    };
  }

  async function runBiber(projectFiles, notify) {
    notify("Bibliography (1/4): Loading Biber helper");
    await ensureLuaWorker(function (message) {
      var text = String(message || "").replace(/\s+/g, " ").trim();
      if (
        text &&
        (/Preparing|Downloading|Fetching|complete|texlive|wasm|package/i.test(text) ||
          text.length < 100)
      ) {
        notify("Bibliography (1/4): Loading Biber helper — " + text);
      }
    });

    notify("Bibliography (2/4): Preparing Biber control file");
    var prep = await postBibToolToWorker(
      projectFilesToBusyTex(projectFiles),
      "biber",
      function (message) {
        var text = String(message || "").replace(/\s+/g, " ").trim();
        if (text) {
          notify("Bibliography (2/4): Preparing Biber control file — " + text);
        }
      }
    );

    var preparedFiles = mergePreparedOutputs(projectFiles, prep && prep.outputs);
    var hasBcf = Object.keys(preparedFiles).some(function (path) {
      return /(^|\/)main\.bcf$/i.test(path) || /\.bcf$/i.test(path);
    });
    if (!hasBcf) {
      return {
        ok: false,
        log:
          (prep && prep.log) ||
          "Missing main.bcf for Biber. Convert a biblatex document once, then try Bib again.",
        outputs: normalizeTextOutputs((prep && prep.outputs) || {}),
      };
    }

    notify("Bibliography (3/4): Running Biber");
    var result = await runTypewardBiber(preparedFiles, function (message) {
      notify("Bibliography (3/4): " + String(message || "Running Biber…"));
    });

    var outputs = Object.assign(
      {},
      normalizeTextOutputs((prep && prep.outputs) || {}),
      result.outputs || {}
    );
    return {
      ok: Boolean(result && result.ok),
      log:
        ((prep && prep.log) || "") +
        "\n\n" +
        ((result && result.log) || "No Biber log returned."),
      outputs: outputs,
    };
  }

  function compileLuaLaTeX(projectFiles, onProgress) {
    var notify = typeof onProgress === "function" ? onProgress : function () {};
    return ensureLuaWorker(function (message) {
      var text = String(message || "");
      if (/Preparing|Downloading|complete/i.test(text)) {
        notify("Downloading LuaLaTeX assets… " + text);
      } else {
        notify(text);
      }
    }).then(function () {
      notify("Converting with LuaLaTeX…");
      return new Promise(function (resolve, reject) {
        if (!luaWorker) {
          reject(new Error("LuaLaTeX worker is not ready."));
          return;
        }

        var settled = false;
        var timeout = setTimeout(function () {
          if (settled) {
            return;
          }
          settled = true;
          closeLuaWorker();
          reject(new Error("LuaLaTeX compilation timed out."));
        }, 300000);

        var finish = function (fn) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          fn();
        };

        luaWorker.onmessage = function (event) {
          var data = event && event.data ? event.data : {};
          if (data.print) {
            notify(String(data.print));
          }
          if (data.pdf !== undefined) {
            finish(function () {
              var ok = data.exit_code === 0 && Boolean(data.pdf);
              var pdfBase64 = null;
              if (ok && data.pdf) {
                pdfBase64 =
                  typeof data.pdf === "string"
                    ? data.pdf
                    : bytesToBase64(
                        data.pdf instanceof Uint8Array
                          ? data.pdf
                          : new Uint8Array(data.pdf)
                      );
              }
              resolve({
                ok: ok,
                pdfBase64: pdfBase64,
                log: data.log || "No compiler log returned.",
              });
            });
            return;
          }
          if (data.exception) {
            finish(function () {
              reject(new Error(String(data.exception)));
            });
          }
        };

        luaWorker.onerror = function (error) {
          finish(function () {
            reject(
              new Error(
                (error && error.message) || "LuaLaTeX worker failed during compile."
              )
            );
          });
        };

        luaWorker.postMessage({
          files: projectFilesToBusyTex(projectFiles),
          main_tex_path: "main.tex",
          bibtex: false,
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

  async function compileAuxPass(projectFiles, onProgress) {
    if (typeof PdfTeXEngine !== "function") {
      throw new Error("PdfTeXEngine is not available.");
    }
    onProgress("Creating main.aux with pdfLaTeX…");
    var engine = new PdfTeXEngine();
    await engine.loadEngine();

    var fmtUrl = new URL("./swiftlatexpdftex.fmt", global.location.href).href;
    var response = await fetch(fmtUrl);
    if (!response.ok) {
      throw new Error("Could not load bundled format (" + response.status + ")");
    }
    var buffer = await response.arrayBuffer();
    await engine.preloadTexFile("swiftlatexpdftex.fmt", buffer);

    var folders = {};
    Object.keys(projectFiles).forEach(function (path) {
      var parts = path.split("/");
      parts.pop();
      var current = "";
      parts.forEach(function (part) {
        current = current ? current + "/" + part : part;
        folders[current] = true;
      });
    });
    Object.keys(folders)
      .sort(function (a, b) {
        return a.split("/").length - b.split("/").length;
      })
      .forEach(function (folder) {
        engine.makeMemFSFolder(folder);
      });

    Object.keys(projectFiles).forEach(function (path) {
      var file = projectFiles[path];
      var content = file.binary
        ? base64ToBytes(file.content)
        : file.content || "";
      engine.writeMemFSFile(path, content);
    });

    engine.setEngineMainFile("main.tex");
    var result = await engine.compileLaTeX();
    try {
      engine.closeWorker();
    } catch (_e) {}

    var aux = (result && result.aux) || {};
    return { aux: aux, log: (result && result.log) || "" };
  }

  async function ensureBibtexAux(projectFiles, onProgress) {
    if (projectUsesHandwrittenBibliography(projectFiles)) {
      throw new Error(
        "This project uses a handwritten thebibliography environment. " +
          "Bib is only needed for \\bibliography{...} with a .bib file."
      );
    }

    if (auxHasBibtexHooks(projectFiles)) {
      onProgress("Using existing main.aux citation data.");
      return { files: projectFiles, wroteAux: false, aux: {} };
    }

    onProgress(
      findMainAux(projectFiles)
        ? "Refreshing main.aux with pdfLaTeX…"
        : "Creating main.aux with pdfLaTeX…"
    );
    var pass = await compileAuxPass(projectFiles, onProgress);
    var merged = mergeAuxIntoProjectFiles(projectFiles, pass.aux);
    if (!findMainAux(merged)) {
      throw new Error(
        "Could not create main.aux. Convert the project once, then run Bib."
      );
    }
    if (!auxHasBibtexHooks(merged)) {
      throw new Error(
        "main.aux has no bibliography commands. Add \\cite{...}, \\bibliographystyle{...}, and \\bibliography{yourfile} to main.tex, Convert once, then run Bib."
      );
    }
    return { files: merged, wroteAux: true, aux: pass.aux };
  }

  /**
   * Bibliography + LuaLaTeX helpers for the Android engine WebView.
   */
  global.UndertwigBibliography = {
    run: async function (projectFiles, onProgress, bibTool) {
      var notify = typeof onProgress === "function" ? onProgress : function () {};
      var tool = String(bibTool || "bibtex").toLowerCase();
      try {
        if (tool === "biber") {
          return await runBiber(projectFiles, notify);
        }
        return await runBibTeX(projectFiles, notify);
      } finally {
        // Drop worker after each run to free memory on phones.
        closeLuaWorker();
      }
    },

    compileLua: async function (projectFiles, onProgress) {
      try {
        return await compileLuaLaTeX(projectFiles, onProgress);
      } finally {
        closeLuaWorker();
      }
    },
  };
})(window);
