# Compliance Checklist

Use this checklist before any public release.

## Engine and dependencies

- [x] SwiftLaTeX PdfTeX WebAssembly assets are vendored under `vendor/swiftlatex/`.
- [x] SwiftLaTeX AGPL-3.0 license text is included at `vendor/swiftlatex/LICENSE`.
- [x] Project `LICENSE` is AGPL-3.0 for the combined work served to users.
- [x] Local SwiftLaTeX modifications are documented in `THIRD_PARTY_NOTICES.md`.
- [x] Corresponding source is offered via the public GitHub repository and in-app Source link.
- [ ] TeXLive package fetching remains available for documents that need packages beyond the local project files.
- [ ] Any engine or TeXLive endpoint change is re-audited for license and source-offer impact.

## Product and branding

- [x] Product branding uses the Undertwig name and an original visual identity.
- [ ] Public marketing copy does not imply affiliation with other LaTeX products.
- [ ] Visual identity remains original enough to avoid trade-dress confusion.

## Legal surfaces

- [x] Project `LICENSE` exists.
- [x] `THIRD_PARTY_NOTICES.md` exists.
- [x] In-app links expose Privacy, Terms, and Source pages.
- [x] Privacy Policy and Terms of Use are published for the public site.
- [ ] Revisit Privacy and Terms before adding accounts, cloud sync, analytics, or server-side file storage.

## Release gate

Before shipping a broader public release:

1. Confirm AGPL source access remains accurate for the exact deployed bytes.
2. Update notices, licenses, versions, and hashes for every newly shipped third-party asset.
3. Verify generated user PDFs remain owned by the user, not the product.
4. Re-run a dependency and branding review.
