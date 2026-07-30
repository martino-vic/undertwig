# Undertwig Android (Phase A)

Native Android shell for Undertwig: project list, monospace editor, on-device pdfLaTeX (SwiftLaTeX Wasm in a headless WebView), and native PDF preview.

This is **not** a Chrome Custom Tab / TWA wrapper of the website.

## Open in Android Studio

1. Install Android Studio (Zorin/Ubuntu: `sudo snap install android-studio --classic`).
2. **File → Open** → select this folder: `undertwig/android` (the directory that contains `settings.gradle.kts`).
3. Wait for Gradle sync (first time downloads the SDK/deps).
4. Create a virtual device (**Device Manager**) or plug in a phone with USB debugging.
5. Click **Run**.

## What works in this build

- Create / open / delete local projects
- Edit `.tex` (and other text files) in a native editor
- **Convert** with bundled SwiftLaTeX Wasm (needs network the first time packages are fetched from TeXlyre, same as the website)
- View generated PDF
- Compiler log sheet
- Google Sign-In (editor top bar **Log in**; session stored on device)
- When logged in, **Save** writes locally and syncs the project to Google Drive (`Undertwig/<project>/`)

## Not in this build yet

- Google Drive load / open from Drive
- Collaborate / invites
- Monaco editor

## Google Sign-In setup

Uses the same public web OAuth client ID as the website (`auth-config.js`) via Credential Manager.

In Google Cloud Console for that project, also create an **Android** OAuth client with:

- Package name: `com.undertwig.app`
- SHA-1 of your signing key (debug keystore for local runs)

Without that Android client, Sign-In fails with a developer/configuration error.

Drive Save requests the same Drive scope as the website (`https://www.googleapis.com/auth/drive`) after login / on first Save.

## Package

`com.undertwig.app` · version `0.1.36`

## Store assets

Play Console uploads (pixel undertwig branding):

- **App icon 512×512:** `android/branding/play_store_icon_512.png`
- **Feature graphic 1024×500:** `android/branding/play_feature_graphic_1024x500.png`
- **Phone screenshots** (1080×2400):
  - `android/branding/screenshots/01-home.png`
  - `android/branding/screenshots/02-editor.png`
  - `android/branding/screenshots/03-pdf.png`
- **7-inch tablet** (1080×1920, 9:16): `android/branding/screenshots/tablet-7/`
- **10-inch tablet** (1800×3200, 9:16): `android/branding/screenshots/tablet-10/`

Launcher icons are generated from the same sample-project twig (`drawable` + `mipmap-*`).

## Troubleshooting crashes

- Prefer an emulator image **with Google Play** (includes Android System WebView).
- If Convert fails later with a WebView error: open Play Store on the emulator → update **Android System WebView** / **Chrome**.
- Cold start no longer creates a WebView (that used to crash on Application context).
- Convert needs network the first time for LaTeX packages (article.cls, etc.). The TeX format file is bundled in the app.
- If the log says `I can't find the format file 'swiftlatexpdftex.fmt'`, do a clean rebuild so `assets/engine/swiftlatexpdftex.fmt` is packaged.
- If Convert fails with `postMessage` / `cannot be converted to a sequence` on a physical phone (common on Samsung WebView), sync/rebuild — the iframe bridge must omit an empty transfer list.
- If Convert fails with `preloadtex failed`, sync/rebuild — the TeX format is fetched in the parent page and installed into the engine iframe via a same-origin call (not `postMessage`).

## License note

The app ships AGPL SwiftLaTeX Wasm assets under `app/src/main/assets/engine/`. See `vendor/swiftlatex/LICENSE` in the repo root.

