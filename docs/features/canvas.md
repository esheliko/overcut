# Feature: the project canvas (PM-01) and project lifecycle (New / Open / Save as)

## Behaviour
- **The canvas is the project's picture**: shape, size in pixels and frame rate. It lives in the project (`Sequence.resolution`, `Sequence.frame_rate`, plus the flags `size_fixed` and `rate_fixed`) and is saved in the `.overcut` file. Preview and export both read the sequence, so they always agree with it. A clip whose size or shape differs from the canvas is **fitted inside it** (letterbox or pillarbox, never cropped: `containScale` in `engine-client/src/render.ts`, applied by `layerOf` in the preview and both exporters). Reframing a project to another shape automatically is TL-24 (M6).
- **Zero-question default ("Match first clip")**: a new project has both flags `false`. The first picture imported sets the size and the frame rate from the clip, exactly as before (`docs/features/media-bin.md`). Each flag, once `true`, protects its own value: choosing a canvas first means the clip no longer overwrites it, and choosing only a size still lets the first clip set the rate.
- **Canvas settings** (the button at the right of the player bar, "Canvas" dialog): Shape (16:9 landscape, 9:16 vertical, 1:1 square, 4:5 portrait, 21:9 cinema, custom size, or Match first clip), Resolution (the short side: 720p, 1080p, 1440p, 4K; 1080 x 1920 for 9:16, 1080 x 1350 for 4:5, 2520 x 1080 for 21:9; both sides are even because H.264 needs it), Frame rate (24, 25, 30, 50, 60 or Match first clip). Custom sizes are 16 to 8192 px per side, rounded to even. The dialog shows the result line before Apply; Apply is disabled when nothing would change.
- **Match first clip is offered only while the project has no picture** (or when it is what the project already does): there is no source size in the model to go back to once a clip is in. To go back, Undo.
- **Changing the canvas is one edit operation** (`set_canvas`, ADR 0006): undoable ("Undo canvas change"), redoable, journaled, recovered after a crash. Clips are untouched: time is integer ticks (ADR 0010), so a new frame rate only changes how often the picture is sampled. The undo step is announced to screen readers.
- Before any picture the preview shows the chosen canvas (empty); with "match" it shows the 16:9 idle sample. The canvas button reads "Canvas: 9:16 · 1080 × 1920 · 25 fps" to assistive technology.

## Project lifecycle (PM-07, in the app menu)
- **Save project as…** writes the current project as a `.overcut` file: the system Save dialog in the desktop app (`desktop_save_project`, atomic write), the File System Access save picker in Chromium, otherwise a download. The name offered is the project name. The file is made by the engine (`saveProject`) over the file the session began from, so fields this version does not know survive.
- **Open project…** reads a `.overcut` file (desktop dialog `desktop_open_project`, open picker, or file input), checks it with the engine first (a damaged file or one from a newer app version is refused with a message; nothing changes), then **replaces** the open project (`ProjectSession.replaceProject`: the file becomes the stored base, the old journal and checkpoint are dropped, undo history starts empty). If the open project has changes not saved to a file since it was loaded, opened, created or last saved, the app asks first.
- **Media on open** is relinked by name and size (`docs/features/persistence.md` for the fingerprint): a file already open in this window with the same name and size reconnects by itself; files stored as `path:` on the desktop reconnect when the path still holds the same file; everything else shows as offline (clips stay) with a "N media files are not on this device yet. Locate files…" note: pick the files (or the folder's files) and they are matched by name and size, each verified by its fingerprint like a single Relink.
- **New project…** asks first when there are unsaved changes, then starts an empty project (1080p30 until the first clip or the canvas settings say otherwise). The previous project is replaced; Save it first to keep it.
- "Unsaved" is relative to a saved file, not to autosave: the working copy is autosaved all the time (`persistence.md`).

## Data and ops
- `Sequence.size_fixed`, `Sequence.rate_fixed`: `bool`, default `false`, omitted from the file while `false`, so older files read as "match" and no schema bump or migration is needed (an older app opening a newer file keeps the fields: unknown JSON is preserved).
- `Op::SetCanvas { sequence, frame_rate, resolution, size_fixed, rate_fixed }`: refuses a zero or non-positive rate, a zero side or a side over 16384; the inverse is the same op with the old values. The first import still uses `SetSequenceFormat` (flags untouched) for the parts that are not fixed.

## Edge cases
- Opening a file whose media is on a different computer: every item is offline, clips and the canvas are intact; Locate files can fix it later.
- Cancelling a dialog (system or in-app) changes nothing. Saving while an export runs is allowed (the project is read, not changed).
- Odd source sizes: a clip of 161 x 121 adopted as the canvas keeps its size (as before); presets and custom sizes are even.

## Tests
- Rust: `set_canvas_is_one_undoable_step_and_validates` (apply, undo, redo, refusals leave the project untouched), `wire_format_matches_the_checked_in_contract` (12 ops), `canvas_choice_round_trips_and_old_files_read_as_not_fixed`, `a_project_file_is_saved_whole_and_read_back_and_only_as_overcut` (`app-store`).
- TypeScript: `tests/unit/canvas.test.ts` (presets, even sizes, import respects fixed flags, choice -> op, file names), `render.test.ts` (`containScale`), `persistence.test.ts` (`replaceProject`: base replaced, journal dropped, recovery after it, refusal leaves everything alone).
- Smoke: `tests/smoke/project-lifecycle.spec.ts` (canvas, undo, import with a chosen canvas, save, new with confirmation, open, refusal of a bad file, relink after reload), desktop and phone.

## Not covered / follow-ups
Version snapshots and the multi-project list (PM-06, M1-034). Renaming the project (the name field is not a project edit yet: the file name comes from it, the name inside the file stays "Untitled project"). Drag-and-drop of a `.overcut` file onto the window. "Open with" from the OS. The desktop dialogs are compile-checked in CI, not exercised by smoke (no webview). Opening a read-only newer file in a read-only viewer.
