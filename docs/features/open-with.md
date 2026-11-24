# Feature: "Open with" and the share sheet (PM-02)

Code: `apps/web/src/incoming.ts` (routing, the hook), `apps/web/public/sw.js` (share target), `apps/web/public/manifest.webmanifest`, desktop: `apps/desktop/src-tauri/src/{lib,desktop}.rs`, `crates/store/src/desktop.rs` (`openable_paths`), `packages/engine-client/src/desktop.ts` (`launchFiles`, `onOpen`). Tests: `tests/unit/incoming.test.ts`, `tests/unit/desktop.test.ts`, `crates/store` (`launch_arguments_keep_media_and_projects_only`), `tests/smoke/open-with.spec.ts`.

## Behaviour
Every way a file can arrive from outside the window ends in the **same two doors as the picker**: a `.overcut` file opens the project (same confirm-if-changed flow and version snapshot as "Open project"), anything else goes to `useMediaBin.importSources` (first import goes onto the timeline, the rest fill the bin; files the decoder cannot use are listed with a reason, as for the picker). Files that arrive before the project session is open wait and are acted on once it is.
- If a batch contains a project file, **only the project opens**; the media that came with it are dropped (importing them into a project that is about to be replaced would lose them). Reversible default; the person can share the media again.
- Nothing is uploaded or contacted: shared files travel page -> service worker -> Cache API on this device -> page, and are deleted from the cache when taken. `config/network-allowlist.json` is unchanged; the smoke test fails on any foreign request.

## Per platform (what is real, what is not)
| Platform | Door | Status |
|---|---|---|
| Android Chrome / Edge, installed PWA | Share sheet: `share_target` (POST multipart to `/share-target`, answered by the service worker, then `/?shared=<id>`) | built; the browser lists OverCut as a share target **only once the app is installed** |
| ChromeOS | same as Android | built, untested on a device |
| Desktop Chrome / Edge, installed PWA | "Open with" / double click: `file_handlers` + `launchQueue` (handles, so a reopened project can find the file again) | built; **not yet verified on a real OS** |
| Desktop Safari, Firefox, iOS Safari (any browser on iOS) | none: these browsers implement neither `file_handlers` nor `share_target` for web apps | **not supported**; the manifest members are ignored, no UI claims support, the picker, drop and paste still work |
| Desktop app (Tauri), Windows and Linux | file associations (`bundle.fileAssociations`: `.overcut` as editor, media types as viewer) hand the file as a launch argument; `desktop_launch_files` returns them once | built; compile-checked in CI only, **not verified on a real OS** |
| Desktop app, macOS | same associations; the OS delivers them as `RunEvent::Opened`, queued the same way and announced with `overcut://open` | built, same caveat |
| Desktop app, a second launch while one is running | **a second window/process starts with its own arguments**. Handing the files to the first window needs `tauri-plugin-single-instance` (a new dependency that cannot be checked without the platform webview libraries): follow-up issue | not built |
| Tauri iOS / Android | not initialised (`tauri ios|android init` not run) | not built |

Feature detection: `launchQueue` and `serviceWorker` are tested for at runtime; a browser without them never fires the door, so there is no broken UI. The app does not show an "open with" or "share" control anywhere (the operating system owns those), so nothing can claim support that is not there.

## Data model and edge cases
- Parked share: Cache `overcut-share`, key `/__shared/<uuid>/<index>`, headers `content-type` and `x-name` (URI-encoded file name). The page accepts only ids it could have produced (`^[A-Za-z0-9-]{8,64}$`), takes entries in index order and deletes them; the `?shared=` is removed from the address bar at once (reload does not re-import).
- A share with no files, or a worker failure, redirects to `/` (nothing happens, no error page).
- A cache entry left behind (tab closed before the page took it) stays until storage is cleared; it is never read without its id. Known gap, small.
- Large videos: `Response(file)` keeps the blob on disk, the page reads it lazily like a picked file; no whole-file copy in JavaScript memory.
- Desktop: only existing files with a media extension or `.overcut` pass `openable_paths`; flags, folders and other documents are ignored.

## Test plan
Unit: routing (project wins, order kept, empty), share id validation, taking parked files (order, names with non-ASCII, only this share, deleted afterwards), manifest and service worker agree on the action and cache, desktop `launchFiles` / `onOpen`, `openable_paths`. Smoke: manifest members; a POST to `/share-target` through the real worker lands the file in the bin with no foreign request.
Not covered: a real OS launching the PWA or the desktop app (needs a device), listed in `docs/M1-STATUS.md`.
