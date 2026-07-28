/* Extends BusytexPipeline with bibliography helpers (bibtex8 + .bcf prep). */
(function (global) {
  if (typeof BusytexPipeline === "undefined" || !BusytexPipeline.prototype) {
    return;
  }

  function projectRel(relativeDir, name) {
    if (!relativeDir || relativeDir === ".") {
      return name;
    }
    return relativeDir + "/" + name;
  }

  BusytexPipeline.prototype._mountProjectFiles = function (Module, files) {
    const FS = Module.FS;
    const PATH = Module.PATH;

    if (
      FS.analyzePath(this.project_dir).object &&
      FS.analyzePath(this.project_dir).object.mount &&
      FS.analyzePath(this.project_dir).object.mount.mountpoint === this.project_dir
    ) {
      FS.unmount(this.project_dir);
    }
    FS.mount(FS.filesystems.MEMFS, {}, this.project_dir);

    const created = new Set(["/", this.project_dir]);
    const sorted = (files || []).slice().sort(function (a, b) {
      return a.path < b.path ? -1 : 1;
    });
    for (let index = 0; index < sorted.length; index += 1) {
      const entry = sorted[index];
      const absolute = PATH.join(this.project_dir, entry.path);
      if (entry.contents == null) {
        this.mkdir_p(FS, PATH, absolute, created);
      } else {
        this.mkdir_p(FS, PATH, PATH.dirname(absolute), created);
        FS.writeFile(absolute, entry.contents);
      }
    }
  };

  BusytexPipeline.prototype._ensureModule = async function () {
    if (!this.Module) {
      this.Module = this.reload_module_if_needed(
        true,
        this.env,
        this.project_dir,
        this.preload_data_packages_js
      );
    }
    return this.Module;
  };

  BusytexPipeline.prototype._runOneLuaPass = function (Module, mainFile) {
    const latexArgs = [
      "luahblatex",
      "-synctex=1",
      "--no-shell-escape",
      "--interaction=nonstopmode",
      "--halt-on-error",
      "--output-format=pdf",
      "--fmt",
      this.fmt.luahbtex,
      "--nosocket",
      mainFile,
    ];
    this.print("$ busytex " + latexArgs.join(" "));
    const latexResult = Module.callMainWithRedirects(latexArgs, true);
    this.print("$ echo $?");
    this.print(String(latexResult.exit_code) + "\n");
    return latexResult;
  };

  /**
   * Ensure <job>.bcf exists (one LuaLaTeX pass if needed) and return it so
   * the main thread can feed typeward's Biber WASM.
   */
  BusytexPipeline.prototype.prepareBiberControlFile = async function (files, mainTexPath) {
    const Module = await this._ensureModule();
    const FS = Module.FS;
    const PATH = Module.PATH;

    this._mountProjectFiles(Module, files);

    const relativeDir = PATH.dirname(mainTexPath || "main.tex");
    const job = PATH.basename(mainTexPath || "main.tex").replace(/\.tex$/i, "");
    const mainFile = PATH.basename(mainTexPath || "main.tex");
    const workDir = PATH.join(this.project_dir, relativeDir === "." ? "" : relativeDir);
    FS.chdir(workDir || this.project_dir);

    const bcfName = job + ".bcf";
    const auxName = job + ".aux";
    let latexLog = "";

    if (!FS.analyzePath(bcfName).exists) {
      this.print("$ # missing " + bcfName + ", running one LuaLaTeX pass first");
      const latexResult = this._runOneLuaPass(Module, mainFile);
      latexLog = [latexResult.stdout || "", latexResult.stderr || ""].join("\n");
    }

    const outputs = {};
    if (FS.analyzePath(bcfName).exists) {
      outputs[projectRel(relativeDir, bcfName)] = this.read_all_text(FS, bcfName);
    }
    if (FS.analyzePath(auxName).exists) {
      outputs[projectRel(relativeDir, auxName)] = this.read_all_text(FS, auxName);
    }

    const hasBcf = Object.keys(outputs).some(function (key) {
      return key.endsWith(".bcf");
    });

    return {
      ok: hasBcf,
      exit_code: hasBcf ? 0 : 1,
      tool: "prepare_bcf",
      log: hasBcf
        ? "$ prepared " + bcfName + " for biber\n" + latexLog
        : "Could not create " +
          bcfName +
          ".\n" +
          "Convert once with a biblatex document, then run Bibliography (Biber).\n\n" +
          latexLog,
      outputs: outputs,
    };
  };

  BusytexPipeline.prototype.runBibTool = async function (files, mainTexPath, tool) {
    const chosen = String(tool || "bibtex").toLowerCase();
    if (chosen === "biber") {
      // Biber runs on the main thread via typeward's WASM; BusyTeX only prepares .bcf.
      return this.prepareBiberControlFile(files, mainTexPath);
    }

    const Module = await this._ensureModule();
    const FS = Module.FS;
    const PATH = Module.PATH;

    this._mountProjectFiles(Module, files);

    const relativeDir = PATH.dirname(mainTexPath || "main.tex");
    const job = PATH.basename(mainTexPath || "main.tex").replace(/\.tex$/i, "");
    const workDir = PATH.join(this.project_dir, relativeDir === "." ? "" : relativeDir);
    FS.chdir(workDir || this.project_dir);

    const auxName = job + ".aux";
    // Do not fall back to a full LuaLaTeX pass here: BusyTeX package resolution
    // can hang the worker (status stuck on "/bin/busytex stderr: (end of list)").
    // The main thread ensures main.aux exists via pdfLaTeX before posting bibtex.
    if (!FS.analyzePath(auxName).exists) {
      return {
        ok: false,
        exit_code: 1,
        tool: "bibtex",
        log:
          "Could not find " +
          auxName +
          " for BibTeX.\n" +
          "Convert the project once first, then run Bibliography.",
        outputs: {},
      };
    }

    this.print("$ busytex bibtex8 --8bit " + job);
    const result = Module.callMainWithRedirects(["bibtex8", "--8bit", job], true);
    this.print("$ echo $?");
    this.print(String(result.exit_code) + "\n");

    const outputs = {};
    const bblName = job + ".bbl";
    const blgName = job + ".blg";
    if (FS.analyzePath(bblName).exists) {
      outputs[projectRel(relativeDir, bblName)] = this.read_all_text(FS, bblName);
    }
    if (FS.analyzePath(blgName).exists) {
      outputs[projectRel(relativeDir, blgName)] = this.read_all_text(FS, blgName);
    }
    if (FS.analyzePath(auxName).exists) {
      outputs[projectRel(relativeDir, auxName)] = this.read_all_text(FS, auxName);
    }

    const logParts = [
      "$ bibtex8 --8bit " + job,
      "EXITCODE: " + result.exit_code,
      "",
      "STDOUT:",
      result.stdout || "",
      "==",
      "STDERR:",
      result.stderr || "",
      "======",
    ];
    const blgKey = Object.keys(outputs).find(function (key) {
      return key.endsWith(".blg");
    });
    if (blgKey) {
      logParts.push("", "BLG:", outputs[blgKey]);
    }

    // bibtex8 often returns exit code 1 when there are only warnings, while still
    // writing a usable .bbl. Treat a produced .bbl as success for the UI.
    const hasBbl = Object.keys(outputs).some(function (key) {
      return key.endsWith(".bbl") && String(outputs[key] || "").trim();
    });
    const exitCode = Number(result.exit_code);
    return {
      ok: hasBbl && (Number.isFinite(exitCode) ? exitCode < 2 : true),
      exit_code: result.exit_code,
      tool: "bibtex",
      log: logParts.join("\n"),
      outputs: outputs,
      warnings: hasBbl && exitCode === 1,
    };
  };
})(self);
