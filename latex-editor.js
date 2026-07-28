/**
 * Undertwig source editor: Monaco on desktop, CodeMirror 6 on mobile.
 * Loaded from CDN; exposes a small sync API used by index.html.
 */
(function (global) {
  "use strict";

  const MOBILE_QUERY = "(max-width: 920px)";
  const MONACO_VER = "0.52.2";
  const MONACO_BASE =
    "https://cdn.jsdelivr.net/npm/monaco-editor@" + MONACO_VER + "/min";

  let hostEl = null;
  let onChange = null;
  let impl = null;
  let initPromise = null;
  let pendingValue = "";
  let pendingReadOnly = false;
  let pendingVisible = true;
  let pendingPath = "";
  let suppressChange = false;
  let resizeObserver = null;

  function prefersMobileEditor() {
    try {
      return global.matchMedia(MOBILE_QUERY).matches;
    } catch (_error) {
      return false;
    }
  }

  function languageForPath(path) {
    const name = String(path || "").toLowerCase();
    if (/\.(tex|sty|cls|clo|dtx|ltx)$/i.test(name)) return "latex";
    if (/\.(md|markdown)$/i.test(name)) return "markdown";
    if (/\.json$/i.test(name)) return "json";
    return "plaintext";
  }

  function emitChange() {
    if (suppressChange || typeof onChange !== "function") {
      return;
    }
    onChange(getValue());
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded === "1") {
          resolve();
          return;
        }
        existing.addEventListener("load", function () {
          resolve();
        });
        existing.addEventListener("error", function () {
          reject(new Error("Failed to load " + src));
        });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.addEventListener("load", function () {
        script.dataset.loaded = "1";
        resolve();
      });
      script.addEventListener("error", function () {
        reject(new Error("Failed to load " + src));
      });
      document.head.appendChild(script);
    });
  }

  function createMonacoImpl() {
    return loadScript(MONACO_BASE + "/vs/loader.js")
      .then(function () {
        return new Promise(function (resolve, reject) {
          try {
            const requirejs = global.require;
            if (!requirejs || !requirejs.config) {
              reject(new Error("Monaco loader missing."));
              return;
            }
            requirejs.config({ paths: { vs: MONACO_BASE + "/vs" } });
            global.MonacoEnvironment = {
              getWorkerUrl: function () {
                const body =
                  "self.MonacoEnvironment={baseUrl:'" +
                  MONACO_BASE +
                  "/'};" +
                  "importScripts('" +
                  MONACO_BASE +
                  "/vs/base/worker/workerMain.js');";
                return URL.createObjectURL(
                  new Blob([body], { type: "text/javascript" })
                );
              },
            };
            requirejs(
              ["vs/editor/editor.main"],
              function () {
                resolve(global.monaco);
              },
              function (err) {
                reject(err || new Error("Monaco failed to load."));
              }
            );
          } catch (error) {
            reject(error);
          }
        });
      })
      .then(function (monaco) {
        monaco.editor.defineTheme("undertwig-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [
            { token: "comment", foreground: "7f8b99", fontStyle: "italic" },
            { token: "keyword", foreground: "d08a45" },
            { token: "string", foreground: "8fbf8f" },
            { token: "number", foreground: "c9a0dc" },
          ],
          colors: {
            "editor.background": "#111820",
            "editor.foreground": "#f3f7fb",
            "editorLineNumber.foreground": "#6b7785",
            "editorLineNumber.activeForeground": "#96a4b3",
            "editorCursor.foreground": "#d08a45",
            "editor.selectionBackground": "#27354588",
            "editor.inactiveSelectionBackground": "#27354555",
            "editor.lineHighlightBackground": "#18212b66",
            "editorWidget.background": "#18212b",
            "editorWidget.border": "#334455",
          },
        });

        const editor = monaco.editor.create(hostEl, {
          value: pendingValue,
          language: languageForPath(pendingPath) === "latex" ? "latex" : "plaintext",
          theme: "undertwig-dark",
          automaticLayout: false,
          fontFamily:
            '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
          fontSize: 14,
          lineHeight: 22,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 18, bottom: 18 },
          tabSize: 2,
          renderLineHighlight: "line",
          overviewRulerLanes: 0,
          folding: true,
          readOnly: pendingReadOnly,
          ariaLabel: "LaTeX source editor",
        });

        editor.onDidChangeModelContent(function () {
          emitChange();
        });

        return {
          kind: "monaco",
          getValue: function () {
            return editor.getValue();
          },
          setValue: function (text) {
            const next = text == null ? "" : String(text);
            if (editor.getValue() === next) {
              return;
            }
            suppressChange = true;
            editor.setValue(next);
            suppressChange = false;
          },
          setReadOnly: function (readOnly) {
            editor.updateOptions({ readOnly: Boolean(readOnly) });
          },
          setVisible: function (visible) {
            hostEl.style.display = visible ? "" : "none";
            if (visible) {
              editor.layout();
            }
          },
          setLanguageForPath: function (path) {
            const model = editor.getModel();
            if (!model) {
              return;
            }
            const id = languageForPath(path);
            monaco.editor.setModelLanguage(
              model,
              id === "latex" ? "latex" : id === "markdown" ? "markdown" : id === "json" ? "json" : "plaintext"
            );
          },
          layout: function () {
            editor.layout();
          },
          dispose: function () {
            editor.dispose();
          },
        };
      });
  }

  function createCodeMirrorImpl() {
    return Promise.all([
      import("https://esm.sh/codemirror@6.0.1"),
      import("https://esm.sh/@codemirror/view@6.36.2"),
      import("https://esm.sh/@codemirror/state@6.5.2"),
      import("https://esm.sh/@codemirror/language@6.10.8"),
      import("https://esm.sh/@codemirror/commands@6.8.0"),
      import("https://esm.sh/@codemirror/legacy-modes@6.4.2/mode/stex?bundle"),
      import("https://esm.sh/@codemirror/theme-one-dark@6.1.2"),
    ]).then(function (mods) {
      const codemirror = mods[0];
      const viewMod = mods[1];
      const stateMod = mods[2];
      const languageMod = mods[3];
      const commandsMod = mods[4];
      const stexMod = mods[5];
      const oneDarkMod = mods[6];

      const EditorView = viewMod.EditorView;
      const basicSetup = codemirror.basicSetup;
      const EditorState = stateMod.EditorState;
      const Compartment = stateMod.Compartment;
      const StreamLanguage = languageMod.StreamLanguage;
      const indentWithTab = commandsMod.indentWithTab;
      const keymap = viewMod.keymap;
      const stex = stexMod.stex || stexMod.stexMath;
      const oneDark = oneDarkMod.oneDark;
      const readOnlyCompartment = new Compartment();

      const undertwigTheme = EditorView.theme(
        {
          "&": {
            height: "100%",
            fontSize: "14px",
            backgroundColor: "#111820",
            color: "#f3f7fb",
          },
          ".cm-scroller": {
            fontFamily:
              '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
            lineHeight: "1.6",
            overflow: "auto",
          },
          ".cm-content": {
            padding: "18px 16px",
            caretColor: "#d08a45",
          },
          ".cm-gutters": {
            backgroundColor: "#111820",
            color: "#6b7785",
            border: "none",
          },
          ".cm-activeLine": { backgroundColor: "#18212b66" },
          ".cm-activeLineGutter": {
            backgroundColor: "#18212b66",
            color: "#96a4b3",
          },
          "&.cm-focused .cm-cursor": { borderLeftColor: "#d08a45" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "#27354588",
          },
        },
        { dark: true }
      );

      const view = new EditorView({
        parent: hostEl,
        state: EditorState.create({
          doc: pendingValue,
          extensions: [
            basicSetup,
            keymap.of([indentWithTab]),
            StreamLanguage.define(stex),
            oneDark,
            undertwigTheme,
            EditorView.lineWrapping,
            readOnlyCompartment.of(EditorState.readOnly.of(pendingReadOnly)),
            EditorView.updateListener.of(function (update) {
              if (update.docChanged) {
                emitChange();
              }
            }),
          ],
        }),
      });

      return {
        kind: "codemirror",
        getValue: function () {
          return view.state.doc.toString();
        },
        setValue: function (text) {
          const next = text == null ? "" : String(text);
          if (view.state.doc.toString() === next) {
            return;
          }
          suppressChange = true;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next },
          });
          suppressChange = false;
        },
        setReadOnly: function (readOnly) {
          view.dispatch({
            effects: readOnlyCompartment.reconfigure(
              EditorState.readOnly.of(Boolean(readOnly))
            ),
          });
        },
        setVisible: function (visible) {
          hostEl.style.display = visible ? "" : "none";
          if (visible) {
            view.requestMeasure();
          }
        },
        setLanguageForPath: function () {},
        layout: function () {
          view.requestMeasure();
        },
        dispose: function () {
          view.destroy();
        },
      };
    });
  }

  function getValue() {
    return impl ? impl.getValue() : pendingValue;
  }

  function setValue(text, path) {
    pendingValue = text == null ? "" : String(text);
    if (path != null) {
      pendingPath = String(path || "");
    }
    if (!impl) {
      return;
    }
    impl.setValue(pendingValue);
    if (impl.setLanguageForPath) {
      impl.setLanguageForPath(pendingPath);
    }
  }

  function setReadOnly(readOnly) {
    pendingReadOnly = Boolean(readOnly);
    if (impl) {
      impl.setReadOnly(pendingReadOnly);
    }
  }

  function setVisible(visible) {
    pendingVisible = Boolean(visible);
    if (hostEl && !impl) {
      hostEl.style.display = pendingVisible ? "" : "none";
    }
    if (impl) {
      impl.setVisible(pendingVisible);
    }
  }

  function layout() {
    if (impl && impl.layout) {
      impl.layout();
    }
  }

  function init(host, options) {
    if (initPromise) {
      return initPromise;
    }
    hostEl = host;
    onChange = options && options.onChange ? options.onChange : null;
    if (!hostEl) {
      return Promise.reject(new Error("Editor host element missing."));
    }

    hostEl.classList.add("code-editor-host");
    hostEl.innerHTML = "";
    hostEl.setAttribute("role", "textbox");
    hostEl.setAttribute("aria-multiline", "true");
    hostEl.setAttribute("aria-label", "LaTeX source editor");

    const useMobile = prefersMobileEditor();
    initPromise = (useMobile ? createCodeMirrorImpl() : createMonacoImpl())
      .catch(function (error) {
        console.warn(
          "Preferred editor failed (" +
            (useMobile ? "CodeMirror" : "Monaco") +
            "), falling back.",
          error
        );
        hostEl.innerHTML = "";
        return useMobile ? createMonacoImpl() : createCodeMirrorImpl();
      })
      .then(function (created) {
        impl = created;
        impl.setValue(pendingValue);
        if (impl.setLanguageForPath) {
          impl.setLanguageForPath(pendingPath);
        }
        impl.setReadOnly(pendingReadOnly);
        impl.setVisible(pendingVisible);
        if (typeof ResizeObserver === "function") {
          resizeObserver = new ResizeObserver(function () {
            layout();
          });
          resizeObserver.observe(hostEl);
        }
        global.addEventListener("resize", layout);
        layout();
        return api;
      });

    return initPromise;
  }

  const api = {
    init: init,
    getValue: getValue,
    setValue: setValue,
    setReadOnly: setReadOnly,
    setVisible: setVisible,
    layout: layout,
    prefersMobileEditor: prefersMobileEditor,
  };

  global.UndertwigEditor = api;
})(typeof window !== "undefined" ? window : globalThis);
