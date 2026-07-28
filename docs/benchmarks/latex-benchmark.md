# Undertwig vs Uni Stuttgart LaTeX Benchmark

Report date: **2026-07-28** (UTC)

This documents a run of the [ITP3 / Uni Stuttgart LaTeX Benchmark](https://web.itp3.uni-stuttgart.de/latex-benchmark/) workload through Undertwig’s in-browser **pdfLaTeX** path (SwiftLaTeX PdfTeX WebAssembly), on the same machine as a native `pdflatex` baseline.

Upstream benchmark: [latex-benchmark](https://web.itp3.uni-stuttgart.de/latex-benchmark/git/) by Nicolai Lang (Institute for Theoretical Physics III, University of Stuttgart), script version **2.0**. Scoreboard: [itp3.info/latexscores](https://itp3.info/latexscores).

## Hardware and software

| Item | Value |
| --- | --- |
| Host | `viktor-vienna` |
| OS | Ubuntu 24.04-based Linux (`7.0.0-28-generic`) |
| CPU | AMD Ryzen 5 PRO 6650U with Radeon Graphics |
| Cores / threads | 6 cores / 12 threads |
| CPU max clock | ~4586 MHz |
| CPU governor during run | `performance` |
| RAM | 14 GiB |
| Browser (headless) | Chromium **131.0.6778.33** (Playwright) |
| Undertwig engine | SwiftLaTeX PdfTeX **0.3.0** (`vendor/swiftlatex/`) |
| Engine TeX format | LaTeX2e `<2020-02-02>` patch level 2 (bundled SwiftLaTeX format) |
| Package fetch | On-demand from `https://texlive.texlyre.org/pdftex/…` |
| Native baseline TeX | TeX Live 2023/Debian — pdfTeX 3.141592653-2.6-1.40.25, BibTeX 0.99d |

## Workload

The official benchmark compiles a stripped QFT lecture-notes project (`QFT.tex` and includes): KOMA-Script (`scrreprt`), TikZ / PGF / `circuitikz` / `tikz-feynman`, `tcolorbox`, `mdframed`, math symbol packages, Hyperref with `backref`, BibTeX, and several PDF/PNG figures (~50 pages of output).

Official protocol (from `latex-benchmark.sh`):

1. **Prepare** — `pdflatex`, then `bibtex` if needed, then further `pdflatex` passes until warnings settle.
2. **Timed phase** — three runs of a single `pdflatex` on the prepared tree; report min / avg / max (one decimal place). Lower is better.

## Method (Undertwig)

Undertwig does not shell out to system TeX. The measurement used the same PdfTeX worker Undertwig loads for **Convert** with the pdfLaTeX engine:

1. Load project files into the SwiftLaTeX memfs (sources + figures + a prepared `main.bbl` / aux helpers).
2. **Prepare** — two `compileLaTeX()` passes (mirrors Undertwig’s usual double pass; also warms the remote package cache).
3. **Timed phase** — three additional single `compileLaTeX()` calls with existing aux restored, wall-clock via `performance.now()` in Chromium.

Entry file was renamed to `main.tex` (Undertwig’s default main file). Content otherwise matched the upstream `benchmark/` tree from the latex-benchmark git mirror.

### Deviations required for a successful Wasm compile

1. **`\clearpage` workaround (harness-only)**  
   Unmodified `\end{document}` failed under SwiftLaTeX with:
   `LaTeX Error: Command \clearpage undefined`  
   after the bibliography had already typeset (~page 51). A harness-only redefine immediately before `\end{document}` was enough:
   ```tex
   \makeatletter
   \def\clearpage{\newpage}
   \makeatother
   ```
   This was **not** applied to upstream sources; it is an engine/kernel quirk with this KOMA + hyperref/backref document on SwiftLaTeX 0.3.0 / LaTeX2e 2020-02-02.

2. **Bibliography `.bbl`**  
   Official prepare uses system `bibtex`. Undertwig’s pdfLaTeX Convert path does not run BibTeX inside the timed `compileLaTeX` call. For parity with the official *timed* phase (which assumes a prepared `.bbl`), BibTeX was run once with native TeX Live and the resulting `QFT.bbl` was supplied as `main.bbl` in the Wasm project.

These deviations mean the result is **not** eligible for the official ITP3 scoreboard key upload (native `pdflatex` + submission key). It is a like-for-like *workload* comparison on one machine.

## Results

Timed phase = three single compiles after prepare (same metric as the public scoreboard).

| Runner | Min (s) | Avg (s) | Max (s) | Notes |
| --- | ---: | ---: | ---: | --- |
| **Undertwig (SwiftLaTeX PdfTeX WASM in Chromium)** | **15.1** | **15.1** | **15.2** | PDF ~991–992 KiB |
| Native `pdflatex` (TeX Live 2023, same host) | 14.2 | 14.4 | 14.6 | Official-script protocol; PDF ~1.0 MiB |

Per-run Undertwig times: `15.2`, `15.1`, `15.1`.

### Extra Undertwig timings (not in the official metric)

| Phase | Time (s) |
| --- | ---: |
| Prepare pass 1 (cold packages + first compile) | 38.13 |
| Prepare pass 2 | 14.91 |

On this host, warm Wasm pdfLaTeX was within ~5% of native TeX Live 2023 for the timed phase. Cold first pass is dominated by remote package downloads into the Wasm FS.

### Scoreboard context

The public scoreboard ranks **native CPUs** by the same document. An average of **15.1 s** would sit among mid-pack laptop/desktop entries on the 2026-07-28 board (roughly the mid-20s by rank; leaders are ~7–9 s on high-end desktop CPUs). That comparison is informal: board entries are native `pdflatex`, not browser Wasm.

## Reproducibility notes

- Upstream one-liner: `bash -c "$(curl -L -s itp3.info/latexbench)"`
- Upstream git: `https://web.itp3.uni-stuttgart.de/latex-benchmark/latex-benchmark.git`
- This run used a local static harness + Playwright against Undertwig’s vendored `PdfTeXEngine.js` / `swiftlatexpdftex.wasm` (not the live website UI).
- Native baseline needed `tensor.sty` and `simplewick.sty` in a user TEXMF tree (not present in the host’s default Debian TeX Live set).

## CI workflow

A manually triggered GitHub Actions workflow runs the same harness:

- Workflow: [`.github/workflows/latex-benchmark.yml`](../../.github/workflows/latex-benchmark.yml) (`workflow_dispatch`)
- Runner script: [`scripts/latex-benchmark/run.sh`](../../scripts/latex-benchmark/run.sh)
- **Green check** = prepare + timed Wasm compiles each produced a PDF (`results.json` status `ok`)
- **Red check** = compile failure, timeout, or harness error

Trigger via the Actions tab → **LaTeX Benchmark** → **Run workflow**. Timings are written to the job summary and uploaded as an artifact; they are informational and do not gate the pass/fail outcome beyond successful PDF production.

## Summary

Undertwig’s browser pdfLaTeX engine **can** compile the Uni Stuttgart LaTeX Benchmark document end-to-end (with the `\clearpage` harness fix and a prepared `.bbl`). On an AMD Ryzen 5 PRO 6650U laptop, warm compile time was **15.1 s average**, versus **14.4 s** for native `pdflatex` on the same machine.
