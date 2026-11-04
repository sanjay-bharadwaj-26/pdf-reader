# PDF Reader

A small desktop PDF reader that looks and behaves like the PDF viewer built into Chromium browsers, plus a one-click **invert page colors** (white ⇄ dark) mode.

Built with [Tauri 2](https://tauri.app) (Rust + the WebView2 already on Windows) and [PDF.js](https://mozilla.github.io/pdf.js/).

## Size and memory

| | |
|---|---|
| Installer / exe | roughly 5-10 MB (no Chromium bundled). Build tools use a few GB temporarily, see below. |
| Build tools (Rust + MSVC + node_modules) | about 3-5 GB, can be deleted after building. Total stays well under 500 MB once you remove them. |
| RAM | Only pages near the viewport are rendered. Off-screen pages free their canvases immediately. Canvases are capped at 10 megapixels. Files are streamed with range requests, not loaded fully into memory. |

WebView2 itself has a baseline of roughly 80-150 MB of RAM that no webview app can avoid.

## Build (Windows)

1. Install [Node.js LTS](https://nodejs.org) and [Rust](https://rustup.rs) (choose the MSVC toolchain; Visual Studio Build Tools "Desktop development with C++" is required).
2. In this folder:

```
npm install        # also copies PDF.js into src/lib automatically
npm run icons      # generates src-tauri/icons from app-icon.png (replace app-icon.png with your own if you like)
npm run build      # produces the installer + exe
```

Output:
- `src-tauri/target/release/pdf-reader.exe` - portable executable (needs WebView2, preinstalled on Windows 11 and updated Windows 10)
- `src-tauri/target/release/bundle/nsis/PDF Reader_1.0.0_x64-setup.exe` - installer; it also registers PDF Reader as an "Open with" option for `.pdf` files

For development use `npm run dev`.

Quick test without Rust: after `npm install`, run `npx serve src` (or `python -m http.server -d src`) and open the page in a browser. It falls back to a file picker.

## Features

- Chromium-style dark toolbar: sidebar toggle, file name, page box `n / total`, zoom -/+ with editable percentage, fit page/width, rotate, download, print, menu
- **Invert colors** button (toolbar, `Ctrl+D`, or the menu), applied per tab. Works both ways: white PDFs become dark, dark PDFs become light. Hues are preserved so images stay recognisable. New tabs start with whatever you used last.
- **Tabs:** every opened PDF gets its own tab (middle-click or × to close, right-click for more, `Ctrl+W` close, `Ctrl+Tab` next tab). PDFs opened from Explorer while the app is running join the same window as new tabs. Each tab remembers its own zoom, scroll position and color inversion.
- **Split view** (`Ctrl+\` or the toolbar button): two PDFs side by side. Click a pane to make it active (the toolbar acts on the active pane). Right-click a tab → *Open in left/right pane*, or drop a file onto a pane. Drag the divider to resize; double-click it to reset.
- **Word documents (.docx)** open in tabs like PDFs (zoom, fit, themes, find, print, "Open with"). They are rendered to HTML, so page breaks and some complex layouts can differ slightly from Word. Old `.doc` files are not supported (save them as .docx first). Word files can't be rendered page-by-page, so very large documents use more RAM than PDFs.
- **Themes** per tab: Original, Dark, Black, Dark (no colors), Sepia, plus a choice of dark backdrop color (Charcoal, Slate blue, Warm brown, Near black), all from the ⋮ menu. `Ctrl+F` finds text in the document.
- Thumbnail sidebar, selectable/copyable text, password-protected PDFs
- Zoom steps identical to Chromium (25%-500%), `Ctrl+wheel`, `Ctrl+ +/-/0`
- `Ctrl+O` open, `Ctrl+S` save a copy, `Ctrl+P` print, `F11` present, drag and drop, "Open with" from Explorer
- Document properties dialog

## Not included yet

Find in document (`Ctrl+F`), annotations/draw/undo/redo, two-page view, form filling, bookmarks outline.

## Optional: even lower RAM

Close PDFs you are not using; hidden tabs already free their rendered pages.
