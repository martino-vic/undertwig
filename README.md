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

## Source

Corresponding source for Undertwig, including the vendored SwiftLaTeX engine and local modifications, is available at:

https://github.com/martino-vic/undertwig

## License

Undertwig is licensed under the GNU Affero General Public License v3.0. See [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

SwiftLaTeX is copyright its respective authors and is also available under AGPL-3.0. See [`vendor/swiftlatex/LICENSE`](vendor/swiftlatex/LICENSE).
