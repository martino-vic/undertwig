# Undertwig

Undertwig is a browser-based LaTeX workspace with a file explorer, source editor, and PDF preview.

Version one runs entirely in the browser: projects stay on the device, there is no account system, and conversion uses the SwiftLaTeX PdfTeX WebAssembly engine locally.

## Features

- Collapsible file explorer
- Create and upload files or folders
- LaTeX source editor
- Convert button with local PDF preview
- Compiler log panel

## Try it

Use the live site: [undertwig.com](https://undertwig.com).

## How conversion works

Convert writes the current project into the SwiftLaTeX in-browser PdfTeX engine and renders the returned PDF in the preview pane. Compilation happens on the user's device. Package resolution may fetch TeX Live resources from the configured on-demand endpoint when needed.

## Project layout

- `index.html` — app UI and conversion workflow
- `privacy.html` — Privacy Policy
- `terms.html` — Terms of Use
- `vendor/swiftlatex/` — SwiftLaTeX PdfTeX WebAssembly engine
- `LICENSE` — GNU AGPL v3.0
- `THIRD_PARTY_NOTICES.md` — third-party dependency notes
- `COMPLIANCE.md` — release checklist

## Source

Corresponding source for Undertwig, including the vendored SwiftLaTeX engine and local modifications, is available at:

https://github.com/martino-vic/undertwig

## License

Undertwig is licensed under the GNU Affero General Public License v3.0. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

SwiftLaTeX is copyright its respective authors and is also available under AGPL-3.0. See [`vendor/swiftlatex/LICENSE`](vendor/swiftlatex/LICENSE).
