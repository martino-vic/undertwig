# BusyTeX (LuaLaTeX support)

Thin local worker/pipeline stubs used by Undertwig for **LuaLaTeX**.

- Upstream: https://github.com/TeXlyre/texlyre-busytex
- License: GNU Affero General Public License v3.0
- Demo / CDN assets: https://texlyre.github.io/texlyre-busytex/core/busytex/

`busytex_worker.js` and `busytex_pipeline.js` are vendored so the Web Worker can load
same-origin. The large WASM module and TeX Live data packages are fetched at runtime
from the TeXlyre BusyTeX GitHub Pages CDN when LuaLaTeX is selected.
