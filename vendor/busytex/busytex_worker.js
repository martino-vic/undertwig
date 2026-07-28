importScripts("busytex_pipeline.js");
importScripts("busytex_bibtool.js?v=20260728al");

self.pipeline = null;

onmessage = async ({ data }) => {
  const {
    files,
    main_tex_path,
    bibtex,
    makeindex,
    rerun,
    busytex_wasm,
    busytex_js,
    preload_data_packages_js,
    data_packages_js,
    texmf_local,
    preload,
    verbose,
    driver,
    remote_endpoint,
    shell_escape,
    load_shell_handler_script,
    read_project_files,
    write_texlive_remote_files,
    write_texlive_remote_misses,
    run_bibtool,
    bib_tool,
    main_job_path,
  } = data || {};

  try {
    if (busytex_wasm && busytex_js && preload_data_packages_js) {
      self.pipeline = new BusytexPipeline(
        busytex_js,
        busytex_wasm,
        data_packages_js,
        preload_data_packages_js,
        texmf_local,
        (message) => postMessage({ print: message }),
        (info) => postMessage({ initialized: info }),
        preload,
        BusytexPipeline.ScriptLoaderWorker
      );
      return;
    }

    if (load_shell_handler_script) {
      importScripts(load_shell_handler_script);
      if (self.handler_ready) {
        await self.handler_ready;
      }
      postMessage({ shell_handler_script_loaded: load_shell_handler_script });
      return;
    }

    if (!self.pipeline) {
      throw new Error("BusyTeX pipeline is not initialized.");
    }

    if (read_project_files) {
      postMessage({
        project_files: await self.pipeline.read_project_files(
          read_project_files.dir || null
        ),
      });
      return;
    }

    if (write_texlive_remote_files) {
      await self.pipeline.write_texlive_remote_files(write_texlive_remote_files);
      postMessage({ texlive_remote_written: true });
      return;
    }

    if (write_texlive_remote_misses) {
      await self.pipeline.write_texlive_remote_misses(write_texlive_remote_misses);
      postMessage({ texlive_remote_misses_written: true });
      return;
    }

    if (run_bibtool) {
      postMessage(
        await self.pipeline.runBibTool(
          files || [],
          main_job_path || main_tex_path || "main.tex",
          bib_tool || "bibtex"
        )
      );
      return;
    }

    if (files) {
      postMessage(
        await self.pipeline.compile(
          files,
          main_tex_path,
          bibtex,
          makeindex,
          rerun,
          verbose,
          driver,
          data_packages_js,
          remote_endpoint,
          shell_escape === true
        )
      );
      return;
    }
  } catch (error) {
    postMessage({
      exception:
        "Exception: " +
        error.toString() +
        "\nStack:\n" +
        (error && error.stack ? error.stack : ""),
    });
  }
};
