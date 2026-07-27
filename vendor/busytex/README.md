# BusyTeX (LuaLaTeX support)

Local worker/pipeline stubs plus a **heap-patched** BusyTeX core used by Undertwig for **LuaLaTeX**.

- Upstream: https://github.com/TeXlyre/texlyre-busytex
- License: GNU Affero General Public License v3.0
- Upstream CDN (TeX Live data packages): https://texlyre.github.io/texlyre-busytex/core/busytex/

## Local core (`busytex.js` / `busytex.wasm`)

These are TeXlyre BusyTeX WASM assets with `MAXIMUM_MEMORY` raised from ~576 MiB to **1 GiB** (`1073741824` bytes):

- WASM memory section max pages: 9216 → 16384
- Matching Emscripten JS heap-max checks in `busytex.js`

TeX Live preload packages (`texlive-basic.js` / `.data`, etc.) are still fetched at runtime from the TeXlyre CDN.
