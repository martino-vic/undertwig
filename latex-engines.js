(function (global) {
  const ENGINE_STORAGE_KEY = "undertwig-latex-engine-v1";
  const BIB_STORAGE_KEY = "undertwig-bib-tool-v1";
  const PDF = "pdflatex";
  const LUA = "lualatex";
  const BIBTEX = "bibtex";
  const BIBER = "biber";
  const LABELS = {
    pdflatex: "pdfLaTeX",
    lualatex: "LuaLaTeX",
  };
  const BIB_LABELS = {
    bibtex: "BibTeX",
    biber: "Biber",
  };
  // Same-origin patched BusyTeX core (1 GiB WASM heap). TeX Live data stays on TeXlyre CDN.
  const BUSYTEX_CORE = new URL("vendor/busytex/", global.location.href).href.replace(
    /\/$/,
    ""
  );
  const BUSYTEX_TEXLIVE =
    "https://texlyre.github.io/texlyre-busytex/core/busytex";
  const BUSYTEX_WORKER = "vendor/busytex/busytex_worker.js?v=20260728ak";
  // BusyTeX kpse_remote expects GET /<format_id>/<filename> (not the pdftex/ prefix).
  const TEXLIVE_REMOTE = "https://texlive2026.texlyre.org/";
  const TEXLIVE_TEX_FORMAT = 26;
  // Runtime files from CTAN macros/luatex/generic/luatexja (beyond texlive-extra).
  const LUATEXJA_FILES = [
    "jfm-CCT.lua",
    "jfm-banjiao.lua",
    "jfm-jis.lua",
    "jfm-kaiming.lua",
    "jfm-min.lua",
    "jfm-mono.lua",
    "jfm-prop.lua",
    "jfm-propv.lua",
    "jfm-propw.lua",
    "jfm-quanjiao.lua",
    "jfm-tmin.lua",
    "jfm-ujis.lua",
    "jfm-ujisv.lua",
    "lltjcore.sty",
    "lltjdefs.sty",
    "lltjext-251101.sty",
    "lltjext.sty",
    "lltjfont.sty",
    "lltjp-array.sty",
    "lltjp-atbegshi.sty",
    "lltjp-collcell.sty",
    "lltjp-everyshi.sty",
    "lltjp-fancyvrb.sty",
    "lltjp-fontspec.sty",
    "lltjp-footmisc.sty",
    "lltjp-geometry.sty",
    "lltjp-listings.sty",
    "lltjp-microtype.sty",
    "lltjp-preview.sty",
    "lltjp-siunitx.sty",
    "lltjp-stfloats.sty",
    "lltjp-tascmac.sty",
    "lltjp-unicode-math.sty",
    "lltjp-xunicode.sty",
    "ltj-adjust.lua",
    "ltj-base.lua",
    "ltj-base.sty",
    "ltj-charrange.lua",
    "ltj-compat.lua",
    "ltj-debug.lua",
    "ltj-direction-20251230.lua",
    "ltj-direction.lua",
    "ltj-inputbuf.lua",
    "ltj-ivd_aj1.lua",
    "ltj-jfmglue.lua",
    "ltj-jfont-20251230.lua",
    "ltj-jfont.lua",
    "ltj-jisx0208.lua",
    "ltj-kinsoku.tex",
    "ltj-latex.sty",
    "ltj-lineskip.lua",
    "ltj-lotf_aux.lua",
    "ltj-math.lua",
    "ltj-otf.lua",
    "ltj-plain.sty",
    "ltj-pretreat.lua",
    "ltj-rmlgbm.lua",
    "ltj-ruby.lua",
    "ltj-setwidth-20251230.lua",
    "ltj-setwidth.lua",
    "ltj-stack.lua",
    "ltj-unicode-ccfix.lua",
    "luatexja-adjust.sty",
    "luatexja-ajmacros.sty",
    "luatexja-compat.sty",
    "luatexja-core.sty",
    "luatexja-fontspec-29e.sty",
    "luatexja-fontspec.sty",
    "luatexja-otf.sty",
    "luatexja-preset.sty",
    "luatexja-ruby.sty",
    "luatexja-zhfonts.sty",
    "luatexja.lua",
    "luatexja.sty",
  ];
  const LIBERTINUS_OTF_FILES = [
    "LibertinusSerif-Regular.otf",
    "LibertinusSerif-Bold.otf",
    "LibertinusSerif-Italic.otf",
    "LibertinusSerif-BoldItalic.otf",
    "LibertinusSerif-Semibold.otf",
    "LibertinusSerif-SemiboldItalic.otf",
    "LibertinusSans-Regular.otf",
    "LibertinusSans-Bold.otf",
    "LibertinusSans-Italic.otf",
    "LibertinusMono-Regular.otf",
  ];
  // fontspec loads these when the thesis uses family names like "Libertinus Serif".
  const LIBERTINUS_FONTSPEC = {
    "Libertinus Serif.fontspec":
      "\\defaultfontfeatures[Libertinus Serif]{\n" +
      "  Extension = .otf,\n" +
      "  UprightFont = LibertinusSerif-Regular,\n" +
      "  BoldFont = LibertinusSerif-Bold,\n" +
      "  ItalicFont = LibertinusSerif-Italic,\n" +
      "  BoldItalicFont = LibertinusSerif-BoldItalic,\n" +
      "  FontFace = {sb}{n}{LibertinusSerif-Semibold},\n" +
      "  FontFace = {sb}{it}{LibertinusSerif-SemiboldItalic},\n" +
      "}\n",
    "Libertinus Sans.fontspec":
      "\\defaultfontfeatures[Libertinus Sans]{\n" +
      "  Extension = .otf,\n" +
      "  UprightFont = LibertinusSans-Regular,\n" +
      "  BoldFont = LibertinusSans-Bold,\n" +
      "  ItalicFont = LibertinusSans-Italic,\n" +
      "}\n",
    "Libertinus Mono.fontspec":
      "\\defaultfontfeatures[Libertinus Mono]{\n" +
      "  Extension = .otf,\n" +
      "  UprightFont = LibertinusMono-Regular,\n" +
      "}\n",
  };
  // Compile-time rewrite: BusyTeX cannot resolve OS font family names.
  const LIBERTINUS_SETMAIN =
    "\\setmainfont{LibertinusSerif-Regular.otf}[\n" +
    "  Path=./,\n" +
    "  BoldFont=LibertinusSerif-Bold.otf,\n" +
    "  ItalicFont=LibertinusSerif-Italic.otf,\n" +
    "  BoldItalicFont=LibertinusSerif-BoldItalic.otf,\n" +
    "  FontFace={sb}{n}{LibertinusSerif-Semibold.otf},\n" +
    "  FontFace={sb}{it}{LibertinusSerif-SemiboldItalic.otf}\n" +
    "]";
  const LIBERTINUS_SETSANS =
    "\\setsansfont{LibertinusSans-Regular.otf}[\n" +
    "  Path=./,\n" +
    "  BoldFont=LibertinusSans-Bold.otf,\n" +
    "  ItalicFont=LibertinusSans-Italic.otf\n" +
    "]";
  const LIBERTINUS_SETMONO =
    "\\setmonofont{LibertinusMono-Regular.otf}[\n" +
    "  Path=./\n" +
    "]";
  const LIBERTINUS_FONT_COMMAND =
    /\\(setmainfont|setsansfont|setmonofont)(?:\s*\[[^\]]*\])?\s*\{(Libertinus(?: Serif| Sans| Mono|Serif|Sans|Mono)?)\}(?:\s*\[[^\]]*\])?/g;

  let selectedEngine = readStoredEngine();
  let selectedBibTool = readStoredBibTool();
  let luaWorker = null;
  let luaReady = false;
  let luaInitPromise = null;
  let luaTexJaReady = false;
  let luaTexJaPromise = null;
  let luaLibertinusReady = false;
  let luaLibertinusPromise = null;
  let luaLibertinusProjectFiles = null;

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

  function readStoredBibTool() {
    try {
      const value = String(localStorage.getItem(BIB_STORAGE_KEY) || "").trim();
      if (value === BIBER || value === BIBTEX) {
        return value;
      }
    } catch (_error) {
      // Ignore.
    }
    return BIBTEX;
  }

  function persistBibTool(id) {
    try {
      localStorage.setItem(BIB_STORAGE_KEY, id);
    } catch (_error) {
      // Ignore.
    }
  }

  function getSelectedBibTool() {
    return selectedBibTool;
  }

  function getSelectedBibToolLabel() {
    return BIB_LABELS[selectedBibTool] || BIB_LABELS.bibtex;
  }

  function setSelectedBibTool(id) {
    const next = id === BIBER ? BIBER : BIBTEX;
    selectedBibTool = next;
    persistBibTool(selectedBibTool);
    return selectedBibTool;
  }

  function listBibTools() {
    return [
      { id: BIBTEX, label: BIB_LABELS.bibtex },
      { id: BIBER, label: BIB_LABELS.biber },
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
    luaTexJaReady = false;
    luaTexJaPromise = null;
    luaLibertinusReady = false;
    luaLibertinusPromise = null;
    luaLibertinusProjectFiles = null;
  }

  function fetchTexLiveFile(name) {
    const url =
      TEXLIVE_REMOTE.replace(/\/?$/, "/") +
      TEXLIVE_TEX_FORMAT +
      "/" +
      encodeURIComponent(name);
    return fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error("Could not download " + name + " (" + response.status + ").");
      }
      return response.arrayBuffer().then(function (buffer) {
        return {
          name: name,
          format: TEXLIVE_TEX_FORMAT,
          contents: new Uint8Array(buffer),
        };
      });
    });
  }

  function fetchTexLiveFiles(names, onProgress) {
    const results = [];
    let index = 0;
    const workers = Math.min(8, names.length);

    function next() {
      if (index >= names.length) {
        return Promise.resolve();
      }
      const current = index;
      index += 1;
      const name = names[current];
      return fetchTexLiveFile(name)
        .then(function (file) {
          results.push(file);
          if (typeof onProgress === "function") {
            onProgress(results.length, names.length, name);
          }
        })
        .catch(function (error) {
          console.warn("[Undertwig] luatexja file skipped:", name, error);
        })
        .then(next);
    }

    const starters = [];
    for (let i = 0; i < workers; i += 1) {
      starters.push(next());
    }
    return Promise.all(starters).then(function () {
      return results;
    });
  }

  function writeLuaRemoteFiles(files) {
    return new Promise(function (resolve, reject) {
      if (!luaWorker) {
        reject(new Error("LuaLaTeX worker is not ready."));
        return;
      }
      if (!files.length) {
        resolve();
        return;
      }

      let settled = false;
      const timeout = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Timed out while registering luatexja files."));
      }, 60000);

      const previous = luaWorker.onmessage;
      luaWorker.onmessage = function (event) {
        const data = event && event.data ? event.data : {};
        if (data.texlive_remote_written) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          luaWorker.onmessage = previous;
          resolve();
          return;
        }
        if (data.exception) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          luaWorker.onmessage = previous;
          reject(new Error(String(data.exception)));
          return;
        }
        if (typeof previous === "function") {
          previous.call(luaWorker, event);
        }
      };

      luaWorker.postMessage({ write_texlive_remote_files: files });
    });
  }

  function stringToUtf8Bytes(text) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text);
    }
    const encoded = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) {
      bytes[index] = encoded.charCodeAt(index);
    }
    return bytes;
  }

  function ensureLuaTexJa(onProgress) {
    if (luaTexJaReady) {
      return Promise.resolve();
    }
    if (luaTexJaPromise) {
      return luaTexJaPromise;
    }

    luaTexJaPromise = fetchTexLiveFiles(LUATEXJA_FILES, function (loaded, total) {
      if (typeof onProgress === "function") {
        onProgress("Loading luatexja (" + loaded + "/" + total + ")…");
      }
    })
      .then(function (files) {
        if (!files.length) {
          throw new Error("Could not download luatexja package files.");
        }
        if (typeof onProgress === "function") {
          onProgress("Registering luatexja with LuaLaTeX…");
        }
        return writeLuaRemoteFiles(files);
      })
      .then(function () {
        luaTexJaReady = true;
      })
      .catch(function (error) {
        luaTexJaPromise = null;
        throw error;
      });

    return luaTexJaPromise;
  }

  function ensureLuaLibertinus(onProgress) {
    if (luaLibertinusReady && luaLibertinusProjectFiles) {
      return Promise.resolve();
    }
    if (luaLibertinusPromise) {
      return luaLibertinusPromise;
    }

    luaLibertinusPromise = fetchTexLiveFiles(
      LIBERTINUS_OTF_FILES,
      function (loaded, total) {
        if (typeof onProgress === "function") {
          onProgress("Loading Libertinus fonts (" + loaded + "/" + total + ")…");
        }
      }
    )
      .then(function (otfFiles) {
        if (!otfFiles.length) {
          throw new Error("Could not download Libertinus font files.");
        }
        const fontspecFiles = Object.keys(LIBERTINUS_FONTSPEC).map(function (name) {
          return {
            name: name,
            format: TEXLIVE_TEX_FORMAT,
            contents: stringToUtf8Bytes(LIBERTINUS_FONTSPEC[name]),
          };
        });
        const allFiles = otfFiles.concat(fontspecFiles);
        luaLibertinusProjectFiles = allFiles.map(function (file) {
          return { path: file.name, contents: file.contents };
        });
        if (typeof onProgress === "function") {
          onProgress("Registering Libertinus fonts with LuaLaTeX…");
        }
        return writeLuaRemoteFiles(allFiles);
      })
      .then(function () {
        luaLibertinusReady = true;
      })
      .catch(function (error) {
        luaLibertinusPromise = null;
        luaLibertinusProjectFiles = null;
        throw error;
      });

    return luaLibertinusPromise;
  }

  function rewriteLibertinusFontCommands(content) {
    if (typeof content !== "string" || content.indexOf("Libertinus") === -1) {
      return content;
    }
    return content.replace(LIBERTINUS_FONT_COMMAND, function (_match, command, family) {
      const normalized = String(family || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (command === "setmainfont" && (normalized === "libertinus serif" || normalized === "libertinusserif")) {
        return LIBERTINUS_SETMAIN;
      }
      if (command === "setsansfont" && (normalized === "libertinus sans" || normalized === "libertinussans")) {
        return LIBERTINUS_SETSANS;
      }
      if (command === "setmonofont" && (normalized === "libertinus mono" || normalized === "libertinusmono")) {
        return LIBERTINUS_SETMONO;
      }
      // Fall back: any setmainfont{Libertinus...} → serif files.
      if (command === "setmainfont" && normalized.indexOf("libertinus") === 0) {
        return LIBERTINUS_SETMAIN;
      }
      if (command === "setsansfont" && normalized.indexOf("libertinus") === 0) {
        return LIBERTINUS_SETSANS;
      }
      if (command === "setmonofont" && normalized.indexOf("libertinus") === 0) {
        return LIBERTINUS_SETMONO;
      }
      return _match;
    });
  }

  function mergeLuaEngineFiles(projectFiles) {
    const files = projectFilesToBusyTex(projectFiles).map(function (file) {
      if (
        typeof file.contents === "string" &&
        /\.(tex|cls|sty)$/i.test(file.path || "")
      ) {
        return {
          path: file.path,
          contents: rewriteLibertinusFontCommands(file.contents),
        };
      }
      return file;
    });
    const seen = {};
    files.forEach(function (file) {
      seen[file.path] = true;
    });
    (luaLibertinusProjectFiles || []).forEach(function (file) {
      if (!seen[file.path]) {
        files.push(file);
        seen[file.path] = true;
      }
    });
    return files;
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
        busytex_js: BUSYTEX_CORE + "/busytex.js",
        busytex_wasm: BUSYTEX_CORE + "/busytex.wasm",
        preload_data_packages_js: [
          BUSYTEX_TEXLIVE + "/texlive-basic.js",
          BUSYTEX_TEXLIVE + "/texlive-recommended.js",
          BUSYTEX_TEXLIVE + "/texlive-extra.js",
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
        aux: auxFiles,
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
    })
      .then(function () {
        return ensureLuaTexJa(notify);
      })
      .then(function () {
        return ensureLuaLibertinus(notify);
      })
      .then(function () {
        notify("Converting with LuaLaTeX…");
        const files = mergeLuaEngineFiles(projectFiles);
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
              new Error(
                (error && error.message) || "LuaLaTeX worker failed during compile."
              )
            );
          };

          luaWorker.postMessage({
            files: files,
            main_tex_path: "main.tex",
            // Auto-run bibtex8 only when the toolbar bibliography tool is BibTeX.
            // Biber documents must use the Bibliography button / a prebuilt .bbl.
            bibtex: selectedBibTool === BIBTEX,
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

  function postBibToolToWorker(files, tool, notify) {
    return new Promise(function (resolve, reject) {
      if (!luaWorker) {
        reject(new Error("LuaLaTeX worker is not ready."));
        return;
      }

      let settled = false;
      const timeoutMs = 90000;
      const timeout = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        // Drop a wedged worker so the next Bibliography/Convert can recover.
        closeLuaWorker();
        luaReady = false;
        luaInitPromise = null;
        reject(
          new Error(
            "Bibliography helper timed out after " +
              Math.round(timeoutMs / 1000) +
              "s. Convert once, then try Bibliography again."
          )
        );
      }, timeoutMs);

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
        if (data.print && typeof notify === "function") {
          notify(String(data.print));
        }
        // Final bibtool responses always include `tool` (bibtex | prepare_bcf).
        // Do not treat progress `{print}` or empty partial objects as completion.
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
        bib_tool: tool,
        files: files,
        main_tex_path: "main.tex",
        main_job_path: "main.tex",
      });
    });
  }

  function findMainAux(projectFiles) {
    const keys = Object.keys(projectFiles || {});
    return (
      keys.find(function (path) {
        return path === "main.aux" || /(^|\/)main\.aux$/i.test(path);
      }) || null
    );
  }

  function mergeAuxIntoProjectFiles(projectFiles, auxFiles) {
    const next = Object.assign({}, projectFiles || {});
    Object.keys(auxFiles || {}).forEach(function (path) {
      const key = String(path).replace(/^\/+/, "");
      if (!key || auxFiles[path] == null) {
        return;
      }
      next[key] = {
        name: key.split("/").pop(),
        content: String(auxFiles[path]),
        binary: false,
      };
    });
    return next;
  }

  function closeEngineQuietly(engine) {
    if (!engine || !engine.closeWorker) {
      return;
    }
    try {
      engine.closeWorker();
    } catch (_error) {
      // Ignore.
    }
  }

  /**
   * BibTeX needs main.aux. Prefer an existing file; otherwise create it with
   * pdfLaTeX (SwiftLaTeX) instead of BusyTeX's LuaLaTeX fallback, which can hang.
   */
  function ensureBibtexAux(projectFiles, notify) {
    if (findMainAux(projectFiles)) {
      return Promise.resolve({ files: projectFiles, wroteAux: false });
    }

    notify("Creating main.aux with pdfLaTeX before BibTeX…");
    return compileWithPdfLaTeX(projectFiles, { onProgress: notify }).then(function (
      result
    ) {
      const aux = (result && result.aux) || {};
      const merged = mergeAuxIntoProjectFiles(projectFiles, aux);
      closeEngineQuietly(result && result.engine);
      if (!findMainAux(merged)) {
        throw new Error(
          "Could not create main.aux. Convert the project once, then run Bibliography."
        );
      }
      return { files: merged, wroteAux: true, aux: aux };
    });
  }

  function projectFilesToTypeward(projectFiles) {
    return Object.keys(projectFiles || {})
      .sort()
      .filter(function (path) {
        const file = projectFiles[path];
        if (file && file.binary) {
          return false;
        }
        // Omit .bbl: typeward skips unchanged inputs from its output map, which
        // made successful Biber runs look like failures and blocked upgrades.
        return /\.(bcf|bib|tex|aux|blg)$/i.test(path);
      })
      .map(function (path) {
        const file = projectFiles[path];
        return {
          path: path,
          content: file && file.content != null ? String(file.content) : "",
        };
      });
  }

  function findProjectBbl(projectFiles, jobname) {
    const exact = jobname + ".bbl";
    const keys = Object.keys(projectFiles || {});
    const hit =
      keys.find(function (path) {
        return path === exact || path.endsWith("/" + exact);
      }) ||
      keys.find(function (path) {
        return /\.bbl$/i.test(path);
      });
    if (!hit) {
      return null;
    }
    const file = projectFiles[hit];
    if (!file || file.binary || file.content == null) {
      return null;
    }
    return { path: hit === exact ? exact : hit, content: String(file.content) };
  }

  function mergePreparedOutputs(projectFiles, outputs) {
    const next = Object.assign({}, projectFiles || {});
    Object.keys(outputs || {}).forEach(function (relPath) {
      const key = String(relPath).replace(/^\/+/, "");
      if (!key || outputs[relPath] == null) {
        return;
      }
      next[key] = {
        name: key.split("/").pop(),
        content: String(outputs[relPath]),
        binary: false,
      };
    });
    return next;
  }

  /**
   * typeward ships Biber 2.19 (BBL format 3.2). BusyTeX/TeXlyre uses
   * TeX Live 2026 biblatex, which expects BBL format 3.3. Header-only
   * rewrites fail: 3.3 adds a trailing /global on \datalist refcontexts
   * and an extra {} on \entry. Upgrade mechanically so Convert can load
   * the bibliography.
   */
  function upgradeBbl32to33(bbl) {
    let s = String(bbl || "");
    if (!s || !/biblatex\s+bbl format version\s+3\.2/i.test(s)) {
      return s;
    }

    // Loose match: Biber's header formatting must not block the bump.
    s = s.replace(/bbl format version\s+3\.2/gi, "bbl format version 3.3");

    s = s.replace(/(\\datalist(?:\[[^\]]*\])?\{)([^}\n]+)(\})/g, function (full, head, ctx, brace) {
      if (/\/global\/global\/global\s*$/.test(ctx)) {
        return full;
      }
      if (/\/global\/global\s*$/.test(ctx)) {
        return head + ctx.replace(/\s*$/, "") + "/global" + brace;
      }
      return full;
    });

    // \entry{key}{type}{} → \entry{key}{type}{}{}
    s = s.replace(/(\\entry\{[^}]+\}\{[^}]*\}\{\})(?!\{)/g, "$1{}");

    return s;
  }

  function upgradeBiberOutputs(outputs) {
    const next = Object.assign({}, outputs || {});
    Object.keys(next).forEach(function (path) {
      if (next[path] == null) {
        return;
      }
      const text = String(next[path]);
      if (!/\.bbl$/i.test(path) && !/biblatex\s+bbl format version/i.test(text)) {
        return;
      }
      next[path] = upgradeBbl32to33(text);
    });
    // Always expose a stable main.bbl key when any job bbl exists.
    if (!next["main.bbl"]) {
      const alt = Object.keys(next).find(function (path) {
        return /(^|\/)main\.bbl$/i.test(path);
      });
      if (alt) {
        next["main.bbl"] = next[alt];
      }
    }
    if (next["main.bbl"] != null) {
      next["main.bbl"] = upgradeBbl32to33(String(next["main.bbl"]));
    }
    return next;
  }

  function runTypewardBiber(projectFiles, notify) {
    notify("Loading Biber WASM (typeward)…");
    const moduleUrl = new URL(
      "vendor/texlive-wasm/run-biber.js?v=20260728aj",
      global.location.href
    ).href;
    return import(moduleUrl).then(function (mod) {
      if (!mod || typeof mod.runBiber !== "function") {
        throw new Error("Biber WASM module failed to load.");
      }
      notify("Running Biber…");
      return mod.runBiber({
        jobname: "main",
        files: projectFilesToTypeward(projectFiles),
        timeoutMs: 300000,
      }).then(function (result) {
        const outputs = Object.assign({}, (result && result.outputs) || {});
        const hasBbl = Object.keys(outputs).some(function (path) {
          return /(^|\/)main\.bbl$/i.test(path) || /\.bbl$/i.test(path);
        });

        // Fallback if WASM omitted an unchanged .bbl despite exit 0.
        if ((result && (result.ok || result.exit_code === 0)) && !hasBbl) {
          const existing = findProjectBbl(projectFiles, "main");
          if (existing) {
            outputs["main.bbl"] = existing.content;
          }
        }

        const upgraded = upgradeBiberOutputs(outputs);
        const ok = Boolean(
          result &&
            (result.ok || result.exit_code === 0) &&
            upgraded["main.bbl"]
        );

        let log = (result && result.log) || "";
        if (upgraded["main.bbl"] && /bbl format version 3\.3/i.test(upgraded["main.bbl"])) {
          log +=
            "\n\nNOTE: Upgraded main.bbl from biblatex format 3.2 → 3.3 for TeX Live 2026.";
        } else if (upgraded["main.bbl"] && /bbl format version 3\.2/i.test(upgraded["main.bbl"])) {
          log +=
            "\n\nWARNING: main.bbl still reports format 3.2 after upgrade attempt.";
        }

        return Object.assign({}, result || {}, {
          ok: ok,
          outputs: upgraded,
          log: log,
        });
      });
    });
  }

  function runBibliography(projectFiles, options) {
    const notify = options && options.onProgress ? options.onProgress : function () {};
    const tool = selectedBibTool;
    const toolLabel = getSelectedBibToolLabel();

    const loadWorker = function () {
      return ensureLuaWorker(function (message) {
        const text = String(message || "");
        if (/Preparing|Downloading|complete/i.test(text)) {
          notify("Downloading LuaLaTeX assets… " + text);
        } else {
          notify(text);
        }
      });
    };

    if (tool !== BIBER) {
      // BibTeX: create aux with pdfLaTeX if needed, then bibtex8 only (no Lua pass).
      return ensureBibtexAux(projectFiles, notify).then(function (auxResult) {
        return loadWorker().then(function () {
          notify("Running " + toolLabel + "…");
          const files = projectFilesToBusyTex(auxResult.files);
          return postBibToolToWorker(files, tool, notify).then(function (data) {
            const outputs = Object.assign({}, data.outputs || {});
            // Surface freshly created aux so the app can persist it.
            if (auxResult.wroteAux && auxResult.aux) {
              Object.keys(auxResult.aux).forEach(function (path) {
                const key = String(path).replace(/^\/+/, "");
                if (key && outputs[key] == null && auxResult.aux[path] != null) {
                  outputs[key] = String(auxResult.aux[path]);
                }
              });
            }
            return {
              ok: Boolean(data.ok),
              tool: data.tool || tool,
              label: toolLabel,
              log: data.log || "No bibliography log returned.",
              outputs: outputs,
              exit_code: data.exit_code,
            };
          });
        });
      });
    }

    return loadWorker()
      .then(function () {
        return ensureLuaTexJa(notify);
      })
      .then(function () {
        return ensureLuaLibertinus(notify);
      })
      .then(function () {
        const files = mergeLuaEngineFiles(projectFiles);
        notify("Preparing Biber control file (.bcf)…");
        return postBibToolToWorker(files, BIBER, notify).then(function (prep) {
          const preparedFiles = mergePreparedOutputs(projectFiles, prep && prep.outputs);
          const hasBcf = Object.keys(preparedFiles).some(function (path) {
            return /(^|\/)main\.bcf$/i.test(path) || /\.bcf$/i.test(path);
          });
          if (!hasBcf) {
            return {
              ok: false,
              tool: BIBER,
              label: toolLabel,
              log: (prep && prep.log) || "Missing main.bcf for Biber.",
              outputs: (prep && prep.outputs) || {},
              exit_code: 1,
            };
          }

          return runTypewardBiber(preparedFiles, notify).then(function (result) {
            const outputs = upgradeBiberOutputs(
              Object.assign({}, (prep && prep.outputs) || {}, result.outputs || {})
            );
            return {
              ok: Boolean(result && result.ok),
              tool: BIBER,
              label: toolLabel,
              log:
                ((prep && prep.log) || "") +
                "\n\n" +
                ((result && result.log) || "No Biber log returned."),
              outputs: outputs,
              exit_code: result && result.exit_code,
            };
          });
        });
      });
  }

  global.UndertwigEngines = {
    PDF: PDF,
    LUA: LUA,
    BIBTEX: BIBTEX,
    BIBER: BIBER,
    LABELS: LABELS,
    BIB_LABELS: BIB_LABELS,
    getSelectedEngine: getSelectedEngine,
    getSelectedEngineLabel: getSelectedEngineLabel,
    setSelectedEngine: setSelectedEngine,
    listEngines: listEngines,
    getSelectedBibTool: getSelectedBibTool,
    getSelectedBibToolLabel: getSelectedBibToolLabel,
    setSelectedBibTool: setSelectedBibTool,
    listBibTools: listBibTools,
    compileProjectFiles: compileProjectFiles,
    runBibliography: runBibliography,
    upgradeBbl32to33: upgradeBbl32to33,
    closeLuaWorker: closeLuaWorker,
  };
})(window);
