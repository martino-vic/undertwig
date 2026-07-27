# Undertwig

Undertwig is a browser-based LaTeX workspace with a file explorer, source editor, and PDF preview.

Local editing and conversion run in the browser: projects stay on the device by default, and conversion uses the SwiftLaTeX PdfTeX WebAssembly engine. Optional Google sign-in unlocks collaboration features.

## Features

- Collapsible file explorer
- Create and upload files or folders
- Drag files into folders or back to the project root
- LaTeX source editor
- Convert button with local PDF preview
- Compiler log panel
- Collaborate control (requires Google sign-in)
- Google-only login page

## Try it

Use the live site: [undertwig.com](https://undertwig.com).

## How conversion works

Convert writes the current project into the SwiftLaTeX in-browser PdfTeX engine and renders the returned PDF in the preview pane. Compilation happens on the user's device. Package resolution may fetch TeX Live resources from the configured on-demand endpoint when needed.

## Authentication

Sign-in is available at [`login.html`](login.html) and supports Google accounts only, via Google Identity Services.

1. Create an OAuth 2.0 Web client ID in Google Cloud Console.
2. Add authorized JavaScript origins for `https://undertwig.com` (and `http://localhost` for local testing).
3. Put the client ID in [`auth-config.js`](auth-config.js). Never put a client secret in the repo.

Security/privacy controls in the current client:

- Cryptographic nonce bound to the Google ID token
- Signature verification against Google’s JWKS
- Audience, issuer, expiry, and `email_verified` checks
- Same-origin-only post-login redirects
- Minimal profile stored locally; raw ID token is not persisted
- Session cleared when the Google credential expires
- Logout clears local state and best-effort revokes the Google grant

Signed-in session details are stored in the browser under `undertwig-auth-v2`.
## Project layout

- `index.html` — app UI and conversion workflow
- `login.html` — Google sign-in page
- `auth.js` / `auth-config.js` — client-side session helpers and Google client ID
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
