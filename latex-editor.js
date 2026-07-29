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
  let onSaveShortcut = null;
  let onConvertShortcut = null;
  let impl = null;
  let initPromise = null;
  let pendingValue = "";
  let pendingReadOnly = false;
  let pendingVisible = true;
  let pendingPath = "";
  let suppressChange = false;
  let resizeObserver = null;
  let latexLanguageRegistered = false;

  function runSaveShortcut() {
    if (typeof onSaveShortcut === "function") {
      onSaveShortcut();
      return true;
    }
    return false;
  }

  function runConvertShortcut() {
    if (typeof onConvertShortcut === "function") {
      onConvertShortcut();
      return true;
    }
    return false;
  }

  function prefersMobileEditor() {
    try {
      const params = new URLSearchParams(global.location && global.location.search);
      if (params.get("editor") === "cm" || params.get("editor") === "mobile") {
        return true;
      }
      if (params.get("editor") === "monaco" || params.get("editor") === "desktop") {
        return false;
      }
      return global.matchMedia(MOBILE_QUERY).matches;
    } catch (_error) {
      return false;
    }
  }

  function languageForPath(path) {
    const name = String(path || "").toLowerCase();
    if (/\.(tex|sty|cls|clo|dtx|ltx|tikz|pgf)$/i.test(name)) return "latex";
    if (/\.(md|markdown)$/i.test(name)) return "markdown";
    if (/\.json$/i.test(name)) return "json";
    return "plaintext";
  }

  /**
   * Monaco does not ship a LaTeX tokenizer. Register a Monarch grammar so
   * .tex / .sty / .cls get real highlighting on desktop.
   */
  function registerLatexLanguage(monaco) {
    if (latexLanguageRegistered) {
      return;
    }
    latexLanguageRegistered = true;

    const existing = monaco.languages.getLanguages().some(function (lang) {
      return lang.id === "latex";
    });
    if (!existing) {
      monaco.languages.register({
        id: "latex",
        extensions: [".tex", ".sty", ".cls", ".clo", ".ltx", ".dtx", ".tikz", ".pgf"],
        aliases: ["LaTeX", "latex", "TeX", "tex"],
        mimetypes: ["text/x-tex", "text/latex"],
      });
    }

    monaco.languages.setLanguageConfiguration("latex", {
      comments: { lineComment: "%" },
      brackets: [
        ["{", "}"],
        ["[", "]"],
        ["(", ")"],
      ],
      autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: "$", close: "$" },
        { open: "`", close: "'" },
      ],
      surroundingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: "$", close: "$" },
      ],
      folding: {
        markers: {
          start: /\\begin\s*\{/,
          end: /\\end\s*\{/,
        },
      },
    });

    const structural =
      "documentclass|usepackage|RequirePackage|begin|end|input|include|includeonly|" +
      "newcommand|renewcommand|providecommand|newenvironment|renewenvironment|" +
      "section|subsection|subsubsection|paragraph|subparagraph|chapter|part|" +
      "label|ref|eqref|pageref|cite|nocite|bibliography|bibliographystyle|" +
      "item|caption|title|author|date|maketitle|tableofcontents|" +
      "includegraphics|href|url|footnote|emph|textbf|textit|texttt|" +
      "centering|hspace|vspace|newline|newpage|clearpage";

    monaco.languages.setMonarchTokensProvider("latex", {
      defaultToken: "",
      tokenPostfix: ".latex",
      tokenizer: {
        root: [
          [/%.*$/, "comment"],
          [/\$\$/, { token: "delimiter.math", next: "@displaymath" }],
          [/\$/, { token: "delimiter.math", next: "@inlinemath" }],
          [/\\\(/, { token: "delimiter.math", next: "@inlinemathParen" }],
          [/\\\[/, { token: "delimiter.math", next: "@displaymathBracket" }],
          [
            /(\\begin)(\s*)(\{)([^\}]*)(\})/,
            ["keyword.control", "white", "delimiter.bracket", "tag", "delimiter.bracket"],
          ],
          [
            /(\\end)(\s*)(\{)([^\}]*)(\})/,
            ["keyword.control", "white", "delimiter.bracket", "tag", "delimiter.bracket"],
          ],
          [
            new RegExp("\\\\(" + structural + ")(?![A-Za-z@])"),
            "keyword.control",
          ],
          [/\\[a-zA-Z@]+/, "keyword"],
          [/\\[^a-zA-Z@]/, "keyword"],
          [/[{}]/, "delimiter.bracket"],
          [/[\[\]]/, "delimiter.square"],
          [/[()]/, "delimiter.parenthesis"],
          [/#+\d?/, "number"],
          [/\d+(?:\.\d+)?(?:em|ex|pt|pc|bp|sp|cm|mm|in|mu)?/, "number"],
          [/[&~^_]/, "operator"],
          [/[^\\%$\[\]{}()#&\s]+/, ""],
          [/\s+/, "white"],
        ],
        inlinemath: [
          [/\$/, { token: "delimiter.math", next: "@pop" }],
          [/\\[a-zA-Z@]+/, "keyword"],
          [/\\[^a-zA-Z@]/, "keyword"],
          [/[{}]/, "delimiter.bracket"],
          [/[^$\\]+/, "string"],
          [/./, "string"],
        ],
        displaymath: [
          [/\$\$/, { token: "delimiter.math", next: "@pop" }],
          [/\\[a-zA-Z@]+/, "keyword"],
          [/\\[^a-zA-Z@]/, "keyword"],
          [/[{}]/, "delimiter.bracket"],
          [/[^$\\]+/, "string"],
          [/./, "string"],
        ],
        inlinemathParen: [
          [/\\\)/, { token: "delimiter.math", next: "@pop" }],
          [/\\[a-zA-Z@]+/, "keyword"],
          [/\\[^a-zA-Z@]/, "keyword"],
          [/[{}]/, "delimiter.bracket"],
          [/[^\\]+/, "string"],
          [/./, "string"],
        ],
        displaymathBracket: [
          [/\\\]/, { token: "delimiter.math", next: "@pop" }],
          [/\\[a-zA-Z@]+/, "keyword"],
          [/\\[^a-zA-Z@]/, "keyword"],
          [/[{}]/, "delimiter.bracket"],
          [/[^\\]+/, "string"],
          [/./, "string"],
        ],
      },
    });
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
        registerLatexLanguage(monaco);

        monaco.editor.defineTheme("undertwig-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [
            { token: "comment", foreground: "7f8b99", fontStyle: "italic" },
            { token: "comment.latex", foreground: "7f8b99", fontStyle: "italic" },
            { token: "keyword", foreground: "d08a45" },
            { token: "keyword.latex", foreground: "d08a45" },
            { token: "keyword.control", foreground: "e0a05a", fontStyle: "bold" },
            { token: "keyword.control.latex", foreground: "e0a05a", fontStyle: "bold" },
            { token: "tag", foreground: "7eb6e0" },
            { token: "tag.latex", foreground: "7eb6e0" },
            { token: "string", foreground: "8fbf8f" },
            { token: "string.latex", foreground: "8fbf8f" },
            { token: "number", foreground: "c9a0dc" },
            { token: "number.latex", foreground: "c9a0dc" },
            { token: "delimiter", foreground: "96a4b3" },
            { token: "delimiter.bracket.latex", foreground: "c7d1dc" },
            { token: "delimiter.math.latex", foreground: "e0a05a" },
            { token: "operator.latex", foreground: "d08a45" },
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

        const initialLang = languageForPath(pendingPath);
        const editor = monaco.editor.create(hostEl, {
          value: pendingValue,
          language: initialLang === "latex" ? "latex" : initialLang,
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

        // Unbind Monaco's Ctrl/Cmd+Enter (insertLineAfter) so Convert can win.
        try {
          if (
            editor._standaloneKeybindingService &&
            typeof editor._standaloneKeybindingService.addDynamicKeybinding ===
              "function"
          ) {
            editor._standaloneKeybindingService.addDynamicKeybinding(
              "-editor.action.insertLineAfter",
              undefined,
              function () {}
            );
          }
        } catch (unbindError) {
          /* private API; capture-phase handler in index.html is the backup */
        }
        if (typeof monaco.editor.addKeybindingRules === "function") {
          monaco.editor.addKeybindingRules([
            {
              keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
              command: null,
            },
          ]);
        }
        editor.addAction({
          id: "undertwig.save",
          label: "Save project",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: function () {
            runSaveShortcut();
          },
        });
        editor.addAction({
          id: "undertwig.convert",
          label: "Convert to PDF",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
          run: function () {
            runConvertShortcut();
          },
        });

        return {
          kind: "monaco",
          getValue: function () {
            return editor.getValue();
          },
          setValue: function (text) {
            const next = text == null ? "" : String(text);
            if (editor.getValue() !== next) {
              suppressChange = true;
              editor.setValue(next);
              suppressChange = false;
            }
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
            const lang =
              id === "latex"
                ? "latex"
                : id === "markdown"
                  ? "markdown"
                  : id === "json"
                    ? "json"
                    : "plaintext";
            if (model.getLanguageId() !== lang) {
              monaco.editor.setModelLanguage(model, lang);
            }
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
    // Matching package versions only — mixing codemirror@6.0.1 basicSetup with a
    // separately pinned @codemirror/view breaks the editor (duplicate copies).
    // Pin state into view/commands so ViewPlugin decorations share one EditorState.
    const cmDeps = "deps=@codemirror/state@6.5.2,@codemirror/view@6.36.2";
    return Promise.all([
      import("https://esm.sh/@codemirror/view@6.36.2?" + cmDeps),
      import("https://esm.sh/@codemirror/state@6.5.2"),
      import("https://esm.sh/@codemirror/commands@6.8.0?" + cmDeps),
    ]).then(function (mods) {
      const viewMod = mods[0];
      const stateMod = mods[1];
      const commandsMod = mods[2];

      const EditorView = viewMod.EditorView;
      const decoApi = viewMod.Decoration;
      const ViewPlugin = viewMod.ViewPlugin;
      const EditorState = stateMod.EditorState;
      const RangeSetBuilder = stateMod.RangeSetBuilder;
      const Compartment = stateMod.Compartment;
      const indentWithTab = commandsMod.indentWithTab;
      const defaultKeymap = commandsMod.defaultKeymap || [];
      const historyKeymap = commandsMod.historyKeymap || [];
      const history = commandsMod.history;
      const keymap = viewMod.keymap;

      if (!decoApi || !ViewPlugin || !RangeSetBuilder) {
        throw new Error("CodeMirror decoration APIs unavailable.");
      }

      const markCache = Object.create(null);
      function markFor(cls) {
        if (!markCache[cls]) {
          markCache[cls] = decoApi.mark({ class: cls });
        }
        return markCache[cls];
      }

      function tokenizeLatexLine(lineText, lineStart, builder) {
        const len = lineText.length;
        let i = 0;
        while (i < len) {
          const ch = lineText.charAt(i);
          if (ch === "%") {
            builder.add(
              lineStart + i,
              lineStart + len,
              markFor("ut-tex-comment")
            );
            return;
          }
          if (ch === "\\") {
            const start = i;
            i += 1;
            if (i < len && /[a-zA-Z@]/.test(lineText.charAt(i))) {
              while (i < len && /[a-zA-Z@]/.test(lineText.charAt(i))) {
                i += 1;
              }
            } else if (i < len) {
              i += 1;
            }
            builder.add(lineStart + start, lineStart + i, markFor("ut-tex-cmd"));
            continue;
          }
          if (ch === "{" || ch === "}" || ch === "[" || ch === "]") {
            builder.add(
              lineStart + i,
              lineStart + i + 1,
              markFor("ut-tex-brace")
            );
            i += 1;
            continue;
          }
          if (ch === "$") {
            const start = i;
            const display = lineText.charAt(i + 1) === "$";
            i += display ? 2 : 1;
            const closer = display ? "$$" : "$";
            const end = lineText.indexOf(closer, i);
            if (end === -1) {
              builder.add(
                lineStart + start,
                lineStart + len,
                markFor("ut-tex-math")
              );
              return;
            }
            i = end + closer.length;
            builder.add(
              lineStart + start,
              lineStart + i,
              markFor("ut-tex-math")
            );
            continue;
          }
          if (/\d/.test(ch)) {
            const start = i;
            while (i < len && /[\d.]/.test(lineText.charAt(i))) {
              i += 1;
            }
            const unit = lineText.slice(i).match(
              /^(em|ex|pt|pc|bp|sp|cm|mm|in|mu)\b/
            );
            if (unit) {
              i += unit[1].length;
            }
            builder.add(
              lineStart + start,
              lineStart + i,
              markFor("ut-tex-number")
            );
            continue;
          }
          i += 1;
        }
      }

      function buildLatexDecorations(view) {
        const builder = new RangeSetBuilder();
        if (languageForPath(pendingPath) !== "latex") {
          return builder.finish();
        }
        // Full-doc tokenize: visibleRanges is often empty on first paint.
        const doc = view.state.doc;
        for (let n = 1; n <= doc.lines; n += 1) {
          const line = doc.line(n);
          tokenizeLatexLine(line.text, line.from, builder);
        }
        return builder.finish();
      }

      const UndertwigHighlight = ViewPlugin.define(
        function (view) {
          return {
            decorations: buildLatexDecorations(view),
            update: function (update) {
              if (
                update.docChanged ||
                update.viewportChanged ||
                update.transactions.length
              ) {
                this.decorations = buildLatexDecorations(update.view);
              }
            },
          };
        },
        {
          decorations: function (value) {
            return value.decorations;
          },
        }
      );

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
          ".ut-tex-cmd": { color: "#d08a45" },
          ".ut-tex-comment": { color: "#7f8b99", fontStyle: "italic" },
          ".ut-tex-brace": { color: "#96a4b3" },
          ".ut-tex-math": { color: "#8fbf8f" },
          ".ut-tex-number": { color: "#c9a0dc" },
        },
        { dark: true }
      );

      const extensions = [
        viewMod.lineNumbers ? viewMod.lineNumbers() : [],
        viewMod.highlightActiveLineGutter
          ? viewMod.highlightActiveLineGutter()
          : [],
        viewMod.highlightActiveLine ? viewMod.highlightActiveLine() : [],
        viewMod.drawSelection ? viewMod.drawSelection() : [],
        history ? history() : [],
        // Custom shortcuts first — CM6 tries keymaps in order.
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: function () {
              return runSaveShortcut();
            },
          },
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: function () {
              return runConvertShortcut();
            },
          },
        ]),
        keymap.of(
          [].concat(defaultKeymap)
            .concat(historyKeymap)
            .concat([indentWithTab])
        ),
        UndertwigHighlight,
        undertwigTheme,
        EditorView.lineWrapping,
        readOnlyCompartment.of(EditorState.readOnly.of(pendingReadOnly)),
        EditorView.updateListener.of(function (update) {
          if (update.docChanged) {
            emitChange();
          }
        }),
      ];

      const view = new EditorView({
        parent: hostEl,
        state: EditorState.create({
          doc: pendingValue,
          extensions: extensions,
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
        setLanguageForPath: function (path) {
          pendingPath = String(path || "");
          view.dispatch({
            userEvent: "undertwig.setLanguage",
          });
        },
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
    onSaveShortcut = options && options.onSave ? options.onSave : null;
    onConvertShortcut = options && options.onConvert ? options.onConvert : null;
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
