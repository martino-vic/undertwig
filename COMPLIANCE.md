# Compliance Checklist

Use this checklist before any monetized or public release.

## Engine and dependencies

- [x] No AGPL-licensed browser LaTeX engine is shipped in this version.
- [x] PDF conversion uses Undertwig's first-party v1 renderer in `index.html`.
- [x] `THIRD_PARTY_NOTICES.md` reflects the current dependency surface.
- [ ] Any future TeX/WASM engine is audited for license, source offer, and notices before merge.
- [ ] Any future TeXLive/package CDN or mirror is self-hosted or pinned, with redistribution notices preserved.

## Product and branding

- [x] Product branding uses the Undertwig name and an original visual identity.
- [ ] Public marketing copy does not imply affiliation with other LaTeX products.
- [ ] Visual identity remains original enough to avoid trade-dress confusion.

## Legal surfaces

- [x] Project `LICENSE` exists.
- [x] `THIRD_PARTY_NOTICES.md` exists.
- [x] In-app links expose License, Notices, and Compliance pages.
- [ ] Terms of Service and Privacy Policy are published before paid accounts, cloud sync, or server-side file storage.

## Release gate

Before shipping a paid feature:

1. Confirm no AGPL runtime is introduced without an explicit AGPL product decision.
2. Update notices, licenses, versions, and hashes for every newly shipped third-party asset.
3. Verify generated user PDFs remain owned by the user, not the product.
4. Re-run a dependency and branding review.
