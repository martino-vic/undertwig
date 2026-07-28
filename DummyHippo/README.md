# DummyHippo

Deliberately heavy multi-file LaTeX project for manual Undertwig Convert checks.

## Import into Undertwig

1. Clone or download this repo.
2. In Undertwig, use the folder/project import control and select the `DummyHippo` directory (the one that contains `main.tex`).
3. Press **Convert** (try pdfLaTeX first, then LuaLaTeX if you want a second opinion).
4. For citations, run **Update Bibliography**, then Convert again.

## What it contains

- Nested `\input` chapters under `chapters/`
- Shared preamble macros in `inc/`
- TikZ + PGFPlots figures under `figures/tikz/`
- A PNG figure at `figures/hippo-grid.png`
- BibTeX database at `bib/references.bib`
- Theorems, tcolorbox callouts, dense math, and wide tables

This is synthetic QA ballast, not a real paper.
