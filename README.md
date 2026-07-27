# Undertwig

Undertwig is a browser-based LaTeX workspace with a file explorer, source editor, and PDF preview.

Version one runs entirely in the browser: projects stay on the device, there is no account system, and conversion uses Undertwig's first-party local renderer.

## Features

- Collapsible file explorer
- Create and upload files or folders
- LaTeX source editor
- Convert button with local PDF preview
- Compiler log panel for conversion notes and unsupported commands

## Try it

Open `index.html` in a modern browser, or use the GitHub Pages deployment for this repository if one is configured.

## How conversion works

Convert parses a supported LaTeX subset from `main.tex` and builds a PDF in the browser. Supported basics include titles, sections, paragraphs, simple lists, and simple math placeholders. Full TeX Live compatibility is not part of this version.

Uploaded binary assets are stored in the project for later use; the v1 renderer does not embed them in the PDF yet.

## Project layout

- `index.html` — app UI and local renderer
- `LICENSE` — project license
- `THIRD_PARTY_NOTICES.md` — third-party dependency notes
- `COMPLIANCE.md` — release checklist

## License

See [`LICENSE`](LICENSE).
