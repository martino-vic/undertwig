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

## Not in this build yet

- Google Sign-In / Drive Save–Load
- Collaborate / invites
- Monaco editor / BusyTeX bibliography
- LuaLaTeX

## Package

`com.undertwig.app` · version `0.1.0`

## Store assets

Play Console uploads (pixel undertwig branding):

- **App icon 512×512:** `android/branding/play_store_icon_512.png`
- **Feature graphic 1024×500:** `android/branding/play_feature_graphic_1024x500.png`

Launcher icons are generated from the same sample-project twig (`drawable` + `mipmap-*`).

## Troubleshooting crashes

- Prefer an emulator image **with Google Play** (includes Android System WebView).
- If Convert fails later with a WebView error: open Play Store on the emulator → update **Android System WebView** / **Chrome**.
- Cold start no longer creates a WebView (that used to crash on Application context).
- Convert needs network the first time for LaTeX packages (article.cls, etc.). The TeX format file is bundled in the app.
- If the log says `I can't find the format file 'swiftlatexpdftex.fmt'`, do a clean rebuild so `assets/engine/swiftlatexpdftex.fmt` is packaged.

## License note

The app ships AGPL SwiftLaTeX Wasm assets under `app/src/main/assets/engine/`. See `vendor/swiftlatex/LICENSE` in the repo root.

