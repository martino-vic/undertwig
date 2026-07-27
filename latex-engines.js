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

  let selectedEngine = readStoredEngine();
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

  function mergeLuaEngineFiles(projectFiles) {
    const files = projectFilesToBusyTex(projectFiles);
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
        busytex_js: BUSYTEX_CDN + "/busytex.js",
        busytex_wasm: BUSYTEX_CDN + "/busytex.wasm",
        preload_data_packages_js: [
          BUSYTEX_CDN + "/texlive-basic.js",
          BUSYTEX_CDN + "/texlive-recommended.js",
          BUSYTEX_CDN + "/texlive-extra.js",
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
