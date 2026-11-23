# Desktop app: end to end (M1-041)

The desktop shell (`apps/desktop/src-tauri`, Tauri 2) hosts the same UI as the web app and answers the same `Engine` interface natively. This file says what works, what is only compile-checked, and how the owner tests it on a Mac or Windows PC.

## Behaviour
- **Import.** "Import" opens the system file dialog (`desktop_pick_media`); files dropped from the OS onto the window arrive as `overcut://drop` events from Rust (`WindowEvent::DragDrop`, media extensions only, folders ignored). Either way the UI gets a `PathFile` (`packages/engine-client/src/desktop.ts`): a `File` that knows its path, reports its real size, and reads bytes only on request (`desktop_read_range`). **Paths, not copies**: the native decoder opens the file in place. The project stores `path:<absolute path>` as the media `uri`.
- **Relink.** On reopening, a stored `path:` uri is tried first; it counts only if the file's size equals the one in the stored fingerprint, else the card shows "Relink" and the existing fingerprint relink applies (same file anywhere on disk, picked with the same dialog).
- **Projects folder.** Projects live in the folder the person chose ("..." menu, "Projects folder…"), default `<app data>/projects`. The choice is `projects-folder.txt` in the app data folder; if that folder disappears (drive unplugged) the app falls back to the default instead of failing. The folder applies from the next start (the open project stays where it was opened). Autosave and crash recovery are the unchanged `store_*` commands (`crates/store`: atomic replace, fsync on append), now rooted there.
- **Export.** The encoder writes into `<app data>/exports`; "Save" opens the system Save dialog and the finished file is copied straight to disk (`<name>.part`, flush, rename; never through the webview, so a 4 GB export does not enter memory). Then "Show in folder" (`open -R`, `explorer /select,`, `xdg-open <folder>`).
- **Codecs and the opt-in download.** `desktop_codecs` reports `h264: hardware | software | none`. With `none` the dialog explains it, offers WebM (VP9, works offline) as the default and the explicit "Enable MP4 (H.264): downloads the free OpenH264 codec from Cisco, about 1 MB, once" button. Nothing is downloaded without the click. Network policy: `docs/features/privacy-network.md`.
- **Opus pre-roll (web and desktop).** `plan_audio` now primes an Opus decoder with at least 600 ms (the S4 finding: 4 packets was 0.19 s and not converged, peak -20 %); other codecs keep 4 packets. Test: `crates/media/tests/host.rs`.

## What is built, what is not
| Piece | State |
|---|---|
| Disk logic (`app_store::desktop`: projects root, drop filter, range read, deliver-with-rename, reveal command) | built, unit-tested on Linux CI |
| `PathFile`, `createDesktopApi`, dialog `desktopFormats` rule | built, unit-tested (`tests/unit/desktop.test.ts`) |
| Tauri commands (`desktop.rs`), dialog plugin, drag-drop events | built, **compile-checked only** (`desktop-check`); never run in a real window |
| libav decode / H.264 + AAC encode behind `native-media` | S4 (PR #53); nothing in CI builds it |
| **WebM (VP9 + Opus) written natively** | **not built**: `desktop_codecs.webm` is `false`, so the dialog offers no format on a computer without H.264 and says to use the browser |
| **OpenH264 downloader** (checksum, store once, load) | **not built**: `canEnableH264` is `false`, the button is hidden |
| Preview of a `PathFile` in the preview Worker | **not built**: the Worker path takes real `Blob`s and a `PathFile` cannot be cloned into it; the desktop preview needs the native frames route (S4 follow-up) |
| Windows: OS drag-drop vs in-app HTML5 drag | **unverified**: Tauri's file-drop handler can swallow HTML5 drag events on WebView2, which would break dragging a bin card onto the timeline there (the "+" button still adds it). Check first on Windows. |

## Rust-level tests
`cargo test -p app-store` covers what the commands do on disk: default and chosen projects folder, fallback when it vanishes, autosave files surviving a restart in the chosen folder, drop filtering, range reads, an export delivered whole or not at all (no `.part` left, wrong type refused), and the reveal command per OS. The Tauri commands themselves are one-line forwards to these; `desktop-check` proves they compile on Linux.

## How the owner tests on Mac / Windows (once a build exists)
1. Install the build from the release dry run (`DEPLOYING.md`; unsigned: macOS right-click, Open; Windows "More info", Run anyway).
2. Drag two videos from Finder / Explorer onto the window: both appear in the bin and on the timeline. Quit, reopen: they come back without asking.
3. "..." menu, "Projects folder…", pick a folder on another drive, restart, import and edit: files appear in it. Kill the app mid-edit (Task Manager): reopening shows the recovery note.
4. Export: Save opens the system dialog; "Show in folder" selects the file. On a machine with a GPU the encoder line says hardware.
5. Windows only: drag a bin card onto the timeline (see the table above) and report if it does nothing.
6. Unplug the network and repeat 2-4: everything works; the export dialog never offers a download unless asked.
