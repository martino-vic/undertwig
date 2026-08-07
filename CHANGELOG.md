# Changelog

## Unreleased — large-project editor UX (`079f54b`)

Branch: `feature/large-project-editor-ux`

### Performance & storage
- IndexedDB workspace storage upgraded to **v2** with **per-file** records instead of one giant blob
- Typing no longer deep-clones / stringifies the whole project; only dirty files flush to the browser
- Large `.tex` documents use a lighter Monaco profile (LaTeX highlighting kept; expensive wrap/fold work reduced)

### Offline editor UX
- Optional **Autosave to Browser (10s)** toggle (off by default)
- Explicit Save / Save file / Ctrl+S still persist when autosave is off
- File-tree **Find files…** search filters Work desk, Cloud, and Drawer

### Layout
- App height uses the visible viewport (`100%` / `100dvh`) so bottom chrome is not clipped
- Compiler log scrolls inside its panel; Privacy / Terms / Source stay visible on large desktops
- Grid columns use `minmax(0, 1fr)` to avoid mid-width horizontal overflow

### Repo
- `.gitignore` ignores `.vercel`
- Cursor rule: commit/push only when the user asks
