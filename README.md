# Undertwig

Undertwig is a browser-based LaTeX workspace with a file explorer, source editor, and PDF preview.

Local editing and conversion run in the browser with the SwiftLaTeX PdfTeX WebAssembly engine. Projects stay on the device by default. Optional Google sign-in unlocks collaboration and free Google Cloud project storage (Google Drive app data for your account).

## Features

- Collapsible file explorer
- Create and upload files or folders
- Download the project as a ZIP
- Drag files into folders or back to the project root
- LaTeX source editor
- Convert button with local PDF preview
- Compiler log panel
- Collaborate control (requires Google sign-in)
- Email collaboration invites via the signed-in user's Gmail
- Google-only login page
- Cloud project storage for signed-in users

## Try it

Use the live site: [www.undertwig.com](https://www.undertwig.com).

## How conversion works

Convert writes the current project into the SwiftLaTeX in-browser PdfTeX engine and renders the returned PDF in the preview pane. Compilation happens on the user's device. Package resolution may fetch TeX Live resources from the configured on-demand endpoint when needed.

## Landscape

A snapshot of the broader LaTeX tooling landscape is in [`docs/latex-tools.csv`](docs/latex-tools.csv), and as a table at the [bottom of this README](#latex-tooling-landscape) (newest first). It is a curated survey of editors, compilers, engines, and related services — from long-standing desktop and cloud products to the recent wave of in-browser, WebAssembly, and AI-assisted tools.

Columns:

- **name**, **url** — product or project
- **year**, **month** — first public appearance, when known
- **AI** — uses AI-assisted writing or compilation (`v` / `X`)
- **WASM** — compiles or previews in the browser via WebAssembly (`v` / `X`)
- **Privacy** — local-first or offline-capable posture (`v` / `X`)
- **Users** — approximate public user, install, or star counts when available

Figures are indicative and not independently audited. Inclusion is not an endorsement.

## Performance

Undertwig was measured against the [Uni Stuttgart / ITP3 LaTeX Benchmark](https://web.itp3.uni-stuttgart.de/latex-benchmark/) (QFT lecture-notes workload). On an AMD Ryzen 5 PRO 6650U, warm in-browser pdfLaTeX averaged **15.1 s** versus **14.4 s** for native TeX Live on the same machine. Full hardware notes, method, caveats, and raw timings: [`docs/benchmarks/latex-benchmark.md`](docs/benchmarks/latex-benchmark.md). Re-run via Actions → **LaTeX Benchmark** (manual workflow; green check means Wasm compile succeeded).

## Authentication and cloud storage

Sign-in is available at [`login.html`](login.html) and supports Google accounts only, via Google Identity Services.

1. Create an OAuth 2.0 Web client ID in Google Cloud Console.
2. Add authorized JavaScript origins for `https://www.undertwig.com` and local origins as needed.
3. On the OAuth consent screen, add scopes:
   - `https://www.googleapis.com/auth/drive.appdata` (Google Drive app data)
   - `https://www.googleapis.com/auth/gmail.send` (collaboration invite emails)
4. Enable the **Google Drive API** and **Gmail API** for the project.
5. Put the client ID in [`auth-config.js`](auth-config.js). Never put a client secret in the repo.

While signed in, Undertwig stores the project JSON in the user's Google Drive **app data** folder via [`cloud-storage.js`](cloud-storage.js). Collaboration invites are sent through the user's Gmail via [`invite.js`](invite.js). Access tokens are kept in memory only. Logged-out use continues to rely on `localStorage`.

Security/privacy controls in the current client:

- Cryptographic nonce bound to the Google ID token
- Signature verification against Google’s JWKS
- Audience, issuer, expiry, and `email_verified` checks
- Same-origin-only post-login redirects
- Minimal profile stored locally; raw ID token is not persisted
- Session cleared when the Google credential expires
- Logout clears local state and best-effort revokes Google grants

Signed-in session details are stored in the browser under `undertwig-auth-v2`.

## Project layout

- `index.html` — app UI and conversion workflow
- `login.html` — Google sign-in page
- `auth.js` / `auth-config.js` — client-side session helpers and Google client ID
- `cloud-storage.js` — Google Drive app-data project sync
- `invite.js` — Gmail-based collaboration invitations
- `privacy.html` — Privacy Policy
- `terms.html` — Terms of Use
- `help-cloud.html` — Google Cloud connection troubleshooting
- `vendor/swiftlatex/` — SwiftLaTeX PdfTeX WebAssembly engine
- `LICENSE` — GNU AGPL v3.0
- `THIRD_PARTY_NOTICES.md` — third-party dependency notes
- `COMPLIANCE.md` — release checklist
- `docs/benchmarks/latex-benchmark.md` — Uni Stuttgart LaTeX Benchmark results
- `docs/latex-tools.csv` — curated survey of LaTeX editors and related tools

## Source

Corresponding source for Undertwig, including the vendored SwiftLaTeX engine and local modifications, is available at:

https://github.com/martino-vic/undertwig

## License

Undertwig is licensed under the GNU Affero General Public License v3.0. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

SwiftLaTeX is copyright its respective authors and is also available under AGPL-3.0. See [`vendor/swiftlatex/LICENSE`](vendor/swiftlatex/LICENSE).

## LaTeX tooling landscape

Sorted by year, then month, newest first. Entries without a known date are listed last. Source: [`docs/latex-tools.csv`](docs/latex-tools.csv). Figures are indicative and not independently audited.

| Name | Year | Month | AI | WASM | Privacy | Users |
| --- | ---: | ---: | :---: | :---: | :---: | ---: |
| [Poiesis](https://github.com/tygopoodt/poiesis) | 2026 | 8 | v | X | v |  |
| [faster-latex demo](https://faster-latex-demo.pages.dev/) | 2026 | 7 | X | v | X | 3 |
| [FastLaTeX / WasmTeX (corca-ai)](https://github.com/corca-ai/wasmtex) | 2026 | 7 | X | v | X | 3 |
| [Oleafly](https://oleafly.com/) | 2026 | 7 | v | X | v | 11 |
| [Texpile](https://desktop.texpile.com/) | 2026 | 7 | X | X | v | 107 |
| [Undertwig](https://www.undertwig.com) | 2026 | 7 | X | v | v |  |
| [InvizCrypt](https://invizcrypt.com/) | 2026 | 5 | X | v | v |  |
| [PaperFit vision typesetting agent](https://arxiv.org/abs/2605.10341) | 2026 | 5 | v | X | X |  |
| [Scribe](https://github.com/sunnyallana/Scribe) | 2026 | 5 | v | X | v | 2 |
| [SonnetPulse](https://www.ntxm.org/products/sonnetpulse/) | 2026 | 5 | X | X | v |  |
| [Tinyleaf](https://github.com/Oaklight/tinyleaf) | 2026 | 4 | X | X | v | 1 |
| [FlowTex](https://github.com/stolucc/flowtex) | 2026 | 3 | v | X | v |  |
| [TeXbrain](https://tex.swimmingbrain.dev/) | 2026 | 3 | X | v | X | 37 |
| [WasmTeX (jere-mie)](https://github.com/jere-mie/wasmtex) | 2026 | 3 | X | v | v | 1 |
| [Bibby AI (trybibby)](https://www.trybibby.com/) | 2026 | 2 | v | v | X |  |
| [OpenPrism (OpenDCAI)](https://github.com/OpenDCAI/OpenPrism) | 2026 | 2 | v | X | v | 331 |
| [LetX](https://letx.app/) | 2026 | 1 | v | X | v | 1,300 |
| [Prism (OpenAI)](https://prism.openai.com/) | 2026 | 1 | v | X | X |  |
| [TeXlyre BusyTeX demo](https://texlyre.github.io/texlyre-busytex/) | 2026 | 1 | X | v | X | 26 |
| [Tylax](https://github.com/scipenai/tylax) | 2026 | 1 | X | X | X | 464 |
| [Tylax (WASM demo)](https://convert.silkyai.cn) | 2026 | 1 | X | v | X |  |
| [TypeTeX](https://www.typetex.app/) | 2026 | 1 | v | v | v |  |
| [agentic-pdf-reconstructor](https://github.com/Ivkalu/agentic-pdf-reconstructor) | 2026 |  | v | X | X |  |
| [deepagents-printshop](https://github.com/kormco/deepagents-printshop) | 2026 |  | v | X | X |  |
| [figura (TikZ vision loop)](https://github.com/chrischoy/figura) | 2026 |  | v | X | X |  |
| [latex-mcp](https://github.com/san-rat/latex-mcp) | 2026 |  | v | X | X |  |
| [MagicTeX MCP](https://github.com/ZoeLinUTS/MagicTeX-mcp) | 2026 |  | v | X | X |  |
| [TexGuardian](https://github.com/latexstudio/TexGuardian) | 2026 |  | v | X | X |  |
| [Siglum](https://github.com/SiglumProject/siglum) | 2025 | 12 | X | v | X | 5 |
| [Thetapad](https://www.thetapad.com/) | 2025 | 12 | v | v | v |  |
| [FormaTeX](https://formatex.io) | 2025 | 9 | v | X | X |  |
| [Octree LaTeX tools](https://github.com/octree-labs/tools) | 2025 | 9 | v | X | X | 12 |
| [TeXlyre](https://texlyre.github.io/texlyre/) | 2025 | 7 | X | v | v | 914 |
| [CollabTeX](https://github.com/JaedenRotondo/CollabTeX) | 2025 | 6 | X | X | X |  |
| [A2R2 Img2LaTeX visual refinement](https://arxiv.org/abs/2507.20890) | 2025 |  | v | X | X |  |
| [PaperDebugger](https://arxiv.org/abs/2512.02589) | 2025 |  | v | X | X |  |
| [TeXRA](https://texra.ai) | 2025 |  | v | X | X |  |
| [Crixet (now Prism)](https://crixet.com/) | 2024 |  | v | v | X |  |
| [inscrive.io](https://inscrive.io) | 2024 |  | v | X | X |  |
| [latex.to](https://latex.to) | 2024 |  | X | X | X |  |
| [LATTE LaTeX iterative refinement](https://arxiv.org/abs/2409.14201) | 2024 |  | v | X | X |  |
| [Murfy](https://www.murfy.ai/en) | 2024 |  | v | X | X | 180,000 |
| [OverleafCopilot](https://arxiv.org/abs/2403.09733) | 2024 |  | v | X | X |  |
| [TexSandbox](https://www.texsandbox.com/) | 2024 |  | v | X | X |  |
| [MiTeX](https://github.com/mitex-rs/mitex) | 2023 |  | X | X | X | 601 |
| [Typst](https://typst.app) | 2023 |  | X | v | X | 55,346 |
| [TikZJax](https://tikzjax.com) | 2022 |  | X | v | X | 3 |
| [WebLaTeX](https://github.com/sanjib-sen/WebLaTex) | 2022 |  | v | X | X | 1,738 |
| [BusyTeX](https://github.com/busytex/busytex) | 2020 |  | X | v | X | 74 |
| [LearnLaTeX.org](https://www.learnlatex.org/) | 2020 |  | X | X | X |  |
| [TeX Live.net](https://texlive.net/) | 2020 |  | X | X | X |  |
| [Kroki](https://kroki.io) | 2019 |  | X | X | X | 4,276 |
| [SwiftLaTeX](https://www.swiftlatex.com) | 2019 |  | X | v | X | 2,316 |
| [LaTeX on HTTP](https://github.com/YtoTech/latex-on-http) | 2017 |  | X | X | X | 81 |
| [MathLive](https://mathlive.io/) | 2017 |  | X | X | X | 2,127 |
| [Mathpix](https://mathpix.com/) | 2017 |  | v | X | X |  |
| [CoCalc](https://cocalc.com/features/latex-editor) | 2016 |  | v | X | X | 300,000 |
| [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) | 2016 |  | X | X | X | 5,447,642 |
| [Tectonic](https://tectonic-typesetting.github.io/) | 2016 |  | X | X | X | 5,014 |
| [BlueLaTeX (publications.li; archived)](https://github.com/BlueLaTeX) | 2015 |  | X | X | X |  |
| [CLSI (Overleaf compile service)](https://github.com/overleaf/clsi) | 2014 |  | X | X | X | 209 |
| [KaTeX](https://katex.org) | 2014 |  | X | X | X | 20,292 |
| [Overleaf](https://www.overleaf.com) | 2014 |  | v | X | X | 20,000,000 |
| [Overleaf Community Edition](https://github.com/overleaf/overleaf) | 2014 |  | X | X | v |  |
| [Authorea](https://www.authorea.com/) | 2013 |  | X | X | X |  |
| [Papeeria](https://papeeria.com/) | 2013 |  | X | X | X |  |
| [VimTeX](https://github.com/lervag/vimtex) | 2013 |  | X | X | X | 6,335 |
| [LaTeX.Online](https://latexonline.cc/) | 2012 |  | X | X | X | 605 |
| [ShareLaTeX (merged into Overleaf)](https://www.sharelatex.com/) | 2012 |  | X | X | X | 1,000,000 |
| [Tables Generator](https://www.tablesgenerator.com/) | 2012 |  | X | X | X |  |
| [Troy Henderson LaTeX previewer](http://www.tlhiv.org/ltxpreview/) | 2012 |  | X | X | X |  |
| [Troy Henderson MetaPost previewer](http://www.tlhiv.org/mppreview/) | 2012 |  | X | X | X |  |
| [ScribTeX (historical; became ShareLaTeX)](https://www.scribtex.com/) | 2011 |  | X | X | X |  |
| [Texpad](https://www.texpad.com/) | 2011 |  | X | X | X |  |
| [upLaTeX](https://ctan.org/pkg/uplatex) | 2011 |  | X | X | X |  |
| [Detexify](https://detexify.kirelabs.org/) | 2010 |  | v | X | X | 842 |
| [Detexify classify](https://detexify.kirelabs.org/classify.html) | 2010 |  | v | X | X |  |
| [GNOME LaTeX](https://gitlab.gnome.org/swilmet/gnome-latex) | 2010 |  | X | X | X |  |
| [LaTeX Lab](http://docs.latexlab.org/) | 2010 |  | X | X | X |  |
| [MathJax](https://www.mathjax.org) | 2010 |  | X | X | X | 10,894 |
| [Biber](https://ctan.org/pkg/biber) | 2009 |  | X | X | X | 387 |
| [Gummi](https://github.com/alexandervdm/gummi) | 2009 |  | X | X | X | 799 |
| [TeXstudio](https://www.texstudio.org/) | 2009 |  | X | X | X | 3,557 |
| [TeXworks](https://tug.org/texworks/) | 2009 |  | X | X | X | 773 |
| [Verbosus / VerbTeX / iVerbTeX](https://verbosus.com/) | 2009 |  | X | X | X | 500,000 |
| [CodeCogs Equation Editor](https://latex.codecogs.com/) | 2007 |  | X | X | X |  |
| [LuaLaTeX](https://www.luatex.org/) | 2007 |  | X | X | X |  |
| [LuaTeX](https://www.luatex.org/) | 2007 |  | X | X | X |  |
| [MacTeX](https://www.tug.org/mactex/) | 2007 |  | X | X | X |  |
| [XeLaTeX](https://tug.org/xetex/) | 2007 |  | X | X | X |  |
| [Pandoc](https://pandoc.org) | 2006 |  | X | X | X | 45,771 |
| [XeTeX](https://tug.org/xetex/) | 2004 |  | X | X | X |  |
| [Kile](https://kile.sourceforge.io/) | 2003 |  | X | X | X | 105 |
| [Texmaker](https://www.xm1math.net/texmaker/) | 2003 |  | X | X | X |  |
| [TeXShop](https://pages.uoregon.edu/koch/texshop/) | 2000 |  | X | X | X |  |
| [TeXnicCenter](https://www.texniccenter.org/) | 1999 |  | X | X | X |  |
| [latexmk](https://ctan.org/pkg/latexmk) | 1998 |  | X | X | X |  |
| [TeXmacs](https://www.texmacs.org/) | 1998 |  | X | X | X | 655 |
| [WinShell](https://www.winshell.org/) | 1998 |  | X | X | X |  |
| [pdfLaTeX](https://www.tug.org/applications/pdftex/) | 1997 |  | X | X | X |  |
| [ConTeXt](https://wiki.contextgarden.net/) | 1996 |  | X | X | X |  |
| [MiKTeX](https://miktex.org/) | 1996 |  | X | X | X | 967 |
| [pdfTeX](https://www.tug.org/applications/pdftex/) | 1996 |  | X | X | X |  |
| [TeX Live](https://www.tug.org/texlive/) | 1996 |  | X | X | X |  |
| [LyX](https://www.lyx.org/) | 1995 |  | X | X | X |  |
| [pLaTeX](https://ctan.org/pkg/platex) | 1995 |  | X | X | X |  |
| [WinEdt](https://www.winedt.com/) | 1993 |  | X | X | X |  |
| [Scientific WorkPlace](https://www.sciword.co.uk/) | 1992 |  | X | X | X |  |
| [AUCTeX](https://www.gnu.org/software/auctex/) | 1991 |  | X | X | X |  |
| [BibTeX](https://ctan.org/pkg/bibtex) | 1985 |  | X | X | X |  |
| [TeX](https://tug.org/) | 1978 |  | X | X | X |  |
| [8gwifi Online LaTeX Editor](https://8gwifi.org/editor) |  |  | v | X | X |  |
| [Auto-LaTeX Equations (Google Docs)](https://workspace.google.com/marketplace/app/auto-latex_equations/848437649689) |  |  | X | X | X | 30,000,000 |
| [ConTeXt on Web (COW)](https://live.contextgarden.net/) |  |  | X | X | X |  |
| [Docx2Latex](https://www.docx2latex.com/) |  |  | X | X | X |  |
| [DynamicDocs API](https://www.dynamicdocs.online/) |  |  | X | X | X |  |
| [ExactPDF LaTeX to PDF](https://exactpdf.com/tools/latex-to-pdf) |  |  | X | X | X |  |
| [Hamline Physics LaTeX Equation Editor](https://www.hamline.edu/personal/arundquist/equationeditor/) |  |  | X | X | X |  |
| [LaTeX 4 Technics](https://www.latex4technics.com/) |  |  | X | X | X |  |
| [LaTeX online-compiler (Halle)](http://latex.informatik.uni-halle.de/) |  |  | X | X | X |  |
| [latex2png (thomasahle)](https://thomasahle.com/latex2png/) |  |  | X | X | X | 47 |
| [latex2png.com](https://latex2png.com/) |  |  | X | X | X |  |
| [mathurl](http://mathurl.com/) |  |  | X | X | X |  |
| [Roger's Online Equation Editor](http://rogercortesi.com/eqn/) |  |  | X | X | X |  |
| [ScienceSoft LaTeX servlet](http://sciencesoft.at/latex/index?lang=en) |  |  | X | X | X |  |
| [SimpleLaTeX](http://simplelatex.com/) |  |  | X | X | X |  |
| [TeXPage](https://www.texpage.com/) |  |  | v | X | X |  |
| [TutorialsPoint Online LaTeX Editor](https://www.tutorialspoint.com/online_latex_editor.php) |  |  | X | X | X |  |
