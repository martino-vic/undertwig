# Third-Party Notices

## SwiftLaTeX PdfTeX WebAssembly engine

- Location: `vendor/swiftlatex/`
- Upstream: https://github.com/SwiftLaTeX/SwiftLaTeX
- Release used: https://github.com/SwiftLaTeX/SwiftLaTeX/releases/tag/v20022022
- License: GNU Affero General Public License v3.0 (`vendor/swiftlatex/LICENSE`)
- Local modifications:
  - `PdfTeXEngine.js`: worker path set to `vendor/swiftlatex/swiftlatexpdftex.js`
  - `swiftlatexpdftex.js`: TeXLive package endpoint set to `https://texlive.texlyre.org/`

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
- Used by: `login.html` for Google-only sign-in (and briefly on logout when revoking access)
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
## Future dependency rules

Before adding any dependency or hosted runtime asset, record:

- Component name and upstream URL
- Exact version, release, or commit
- License identifier and full license text
- Whether the component is served to users
- Whether corresponding source, notices, or attribution are required
