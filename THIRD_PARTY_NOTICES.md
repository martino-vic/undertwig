# Third-Party Notices

## SwiftLaTeX PdfTeX WebAssembly engine

- Location: `vendor/swiftlatex/`
- Upstream: https://github.com/SwiftLaTeX/SwiftLaTeX
- Release used: https://github.com/SwiftLaTeX/SwiftLaTeX/releases/tag/v20022022
- License: GNU Affero General Public License v3.0 (`vendor/swiftlatex/LICENSE`)
- Local modifications:
  - `PdfTeXEngine.js`: worker path set to `vendor/swiftlatex/swiftlatexpdftex.js`;
    compile results may include auxiliary files (`.aux`, `.toc`, …)
  - `swiftlatexpdftex.js`: TeXLive package endpoint set to `https://texlive.texlyre.org/`
  - `swiftlatexpdftex.js`: project files are tracked in JS and re-applied after each
    heap restore; auxiliary files are returned so the app can run a second pass for
    `\tableofcontents` and cross-references without crashing the engine

Undertwig loads these assets in the browser to compile LaTeX to PDF locally.

Corresponding source for this repository, including the vendored SwiftLaTeX assets
and local modifications, is available at:

https://github.com/martino-vic/undertwig

## Browser platform APIs

The app also uses browser-provided APIs such as `Blob`, file inputs, `localStorage`,
`Worker`, and `URL.createObjectURL`. Those APIs are supplied by the user's browser
and are not redistributed as part of this project.

## Google Identity Services

- Loaded at runtime from: `https://accounts.google.com/gsi/client`
- Used by: `login.html` for Google-only sign-in, and by the editor when authorizing
  or revoking Google Drive app-data access for cloud project storage
- Token key discovery: `https://www.googleapis.com/oauth2/v3/certs`
- License / terms: Google APIs Terms of Service and Google Identity Services terms
  (see https://developers.google.com/identity and https://policies.google.com/terms)
- Notes:
  - The Google script is not vendored in this repository; the browser loads it from Google.
  - Undertwig verifies ID token signatures with Web Crypto against Google’s JWKS, checks
    audience/issuer/expiry/email_verified/nonce, and stores only a minimal local profile
    in `localStorage` (`undertwig-auth-v2`). The raw ID token is not persisted.
  - Configure the OAuth 2.0 Web client ID in `auth-config.js`. Never ship a client secret
    in this static site.

## Google Drive API (app data)

- Runtime API: `https://www.googleapis.com/drive/v3` and upload endpoint
- Used by: `cloud-storage.js` for signed-in project persistence
- Scope: `https://www.googleapis.com/auth/drive.appdata`
- License / terms: Google APIs Terms of Service
- Notes:
  - Project JSON is stored in the signed-in user's Drive application-data space.
  - OAuth access tokens are held in memory only and revoked on logout when possible.
  - Enable the Drive API and app-data scope on the OAuth consent screen in Google Cloud.

## Gmail API (collaboration invites)

- Runtime API: `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
- Used by: `invite.js` when a signed-in user sends a collaboration invitation
- Scope: `https://www.googleapis.com/auth/gmail.send`
- License / terms: Google APIs Terms of Service
- Notes:
  - Invites are sent from the signed-in user's Gmail account, not from Undertwig servers.
  - Enable the Gmail API and `gmail.send` scope on the OAuth consent screen in Google Cloud.
  - Access tokens for sending mail are held in memory only and revoked on logout when possible.

## Future dependency rules

Before adding any dependency or hosted runtime asset, record:

- Component name and upstream URL
- Exact version, release, or commit
- License identifier and full license text
- Whether the component is served to users
- Whether corresponding source, notices, or attribution are required
