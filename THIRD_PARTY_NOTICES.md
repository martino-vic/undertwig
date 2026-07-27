# Third-Party Notices

This version of Undertwig does not ship third-party JavaScript libraries,
WebAssembly engines, fonts, TeXLive packages, or compiler assets.

The previous SwiftLaTeX browser engine bundle was removed. PDF conversion is
implemented by Undertwig's first-party v1 renderer in `index.html`.

Browser-provided platform APIs used by the app include:

- `Blob`
- `File`
- `FileReader` / file input APIs
- `localStorage`
- `TextEncoder`
- `URL.createObjectURL`

These APIs are supplied by the user's browser and are not redistributed as part
of this project.

## Future Dependency Rules

Before adding any dependency or hosted runtime asset, record:

- Component name and upstream URL
- Exact version, release, or commit
- License identifier and full license text
- Whether the component is served to users, bundled in source, or only used in
  development
- Whether corresponding source, notices, relink materials, or attribution are
  required

Do not add AGPL-licensed runtime code unless the whole deployed application is
intentionally made AGPL-compliant and source-available to users.
