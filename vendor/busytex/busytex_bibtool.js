/* Extends BusytexPipeline with a bibliography-only pass (bibtex8). */
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

  BusytexPipeline.prototype.runBibTool = async function (files, mainTexPath, tool) {
    const chosen = String(tool || "bibtex").toLowerCase();
    if (chosen === "biber") {
      return {
        ok: false,
        exit_code: 1,
        tool: "biber",
        log:
          "Biber is not available in the browser WebAssembly toolchain.\n" +
          "Run `biber main` locally (same folder as main.tex), then Import the resulting main.bbl into this project and Convert again.",
        outputs: {},
      };
    }

    if (!this.Module) {
      this.Module = this.reload_module_if_needed(
        true,
        this.env,
        this.project_dir,
        this.preload_data_packages_js
      );
    }
    const Module = await this.Module;
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

    const relativeDir = PATH.dirname(mainTexPath || "main.tex");
    const job = PATH.basename(mainTexPath || "main.tex").replace(/\.tex$/i, "");
    const mainFile = PATH.basename(mainTexPath || "main.tex");
    const workDir = PATH.join(this.project_dir, relativeDir === "." ? "" : relativeDir);
    FS.chdir(workDir || this.project_dir);

    const auxName = job + ".aux";
    if (!FS.analyzePath(auxName).exists) {
      this.print("$ # missing " + auxName + ", running one LuaLaTeX pass first");
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
      if (!FS.analyzePath(auxName).exists) {
        return {
          ok: false,
          exit_code: latexResult.exit_code || 1,
          tool: "bibtex",
          log:
            "Could not create " +
            auxName +
            " for BibTeX.\n" +
            "Convert the project once first, then run Bibliography.\n\n" +
            (latexResult.stdout || "") +
            "\n" +
            (latexResult.stderr || ""),
          outputs: {},
        };
      }
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

    return {
      ok:
        result.exit_code === 0 &&
        Boolean(
          Object.keys(outputs).some(function (key) {
            return key.endsWith(".bbl");
          })
        ),
      exit_code: result.exit_code,
      tool: "bibtex",
      log: logParts.join("\n"),
      outputs: outputs,
    };
  };
})(self);
