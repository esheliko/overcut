# Feature: media bin and import (M1-032)

Code: `apps/web/src/media/` (`plan.ts` pure logic, `sources.ts` picker/drop/paste/handles, `probe.ts`, `useMediaBin.ts` state, `MediaBin.tsx` UI), wiring in `App.tsx`. Tests: `tests/unit/media-plan.test.ts`, `tests/smoke/media-bin.spec.ts`.
Serves the activation test (PRODUCT.md: import, trim, export in under 90 s for a first-time user): **zero setup questions**.

## Behaviour
- **A project exists from the first second.** When the engine is ready the app opens an empty project (one sequence, one video track `V1`, one audio track `A1`, 1920x1080, 30 fps, 48 kHz). No "new project" dialog.
- **Import** (all paths end in `useMediaBin.importSources`):
  - the big **Import media** target (empty bin) or the **Import media** button (bin has items): the system picker, multiple files, `video/*,audio/*,image/*`. On Chromium desktop (`showOpenFilePicker`, fine pointer) it returns **file handles**; elsewhere a plain `<input type=file multiple accept=...>`, which on iOS and Android offers the camera roll.
  - **Drag and drop** of files anywhere on the page (the window listens; a full-screen "Drop to import" overlay shows while files are over the page). Dropping on the timeline or preview is the same import. Folders are ignored.
  - **Paste** (`Ctrl/Cmd+V`) of files, except inside text fields.
- **The very first import into an empty project goes straight onto the timeline, at 0, and sets the sequence's frame rate and size from the first clip with a picture** (rotation applied: a phone clip with a 90 degree matrix gives 1080x1920... swapped sides; variable frame rate or no rate gives 30). Every file of that first batch is appended in order. Later imports only fill the bin. An audio file never changes the sequence; the first picture added afterwards does, while the project still has no picture media (`sequenceIsUnset`). The preview shape selector snaps to the closest of its four shapes.
- **Add to timeline**: the `+` button on a card (44 px, labelled "Add <name> to the timeline", Enter/Space from the keyboard, announced "Added to the timeline"), or **drag a card onto the timeline** (mouse/pen; touch uses `+`). Placement: at the playhead when both tracks are free there, else after the last clip. A video with sound becomes **two clips** (picture on the first video track, sound on the first audio track) from **one op array = one undo step**; audio goes on the audio track; a still is `STILL_SECONDS` (5 s) long. Ops are `insert_clip` through `Engine.editing.apply` (ADR 0006), never direct mutation.
- **Each card shows** a poster (first decoded frame, 320 px JPEG, or a stills's own image; audio gets an icon), name, length, size in pixels, codec ("H.264 + AAC"), file size. Search box filters by name.
- **Probe on import**: `Engine.media.open(file)`: the container index is read with range reads (`Blob.slice`), the bytes of the file are never loaded whole (a 64 MB file opens by reading a sliver: media-io.md). The handle is closed after the poster is drawn; preview (M1-033) opens it again. Stills go through `createImageBitmap` (the browser decodes them).
- **Errors are never silent.** A card turns red and says, in order: the file name and format, the engine's own sentence (which names the codec in words: "This device cannot decode H.265 (HEVC) video (...). Convert the file to H.264/AAC ..."), and what works everywhere. A non-media file ("notes.pdf is not a video, audio or image file, so it was skipped") and a damaged file ("could not be read") get their own messages. The message is also announced to screen readers; the card has a dismiss button.
- **Reopening** (hook for M1-040 autosave, `adoptProject`): each media's `uri` is `fs:<id>` (handle stored in IndexedDB `overcut-media`) on Chromium, else `file:<name>:<size>`. On project open `loadHandle(uri)` restores the `File` when permission is still granted; otherwise the card is **offline** with a **Relink** button (permission prompt for a stored handle, else a normal picker that must give a file of the same size). Offline media keep their clips; nothing is deleted.

## Data model
`MediaRef { id, kind, name, uri, duration (null for stills), hash }`. `hash` stays `null` here: the fingerprint (`b3-64k:...`, project-file.md) is computed by M1-040 together with relink-by-content.

## Accessibility and layout
Every action is a real button (picker, `+`, dismiss, relink); cards are a labelled list; state changes use the live region. Targets are at least 44 px; the bin is the Media sheet on a phone and the left panel from 720 px; the page never scrolls sideways (smoke checks it).

## Limits and decisions
- **Media is not an edit op yet.** Adding a `MediaRef` (and setting the sequence size on the first import) reopens the project in the engine with `Editing.open`, which **starts a fresh undo history**. Undo of the timeline insert itself works (one step per add), but an import after some edits clears earlier undo. The clean fix is `add_media` / `set_sequence` ops in `app-timeline` (+ `edit-contract.json`); filed as a follow-up for the manager.
- Matroska (`.mkv`), MP3 and WAV are not importable yet (the demuxer reads MP4/MOV/WebM; media-io.md): they get the friendly "could not be imported" message with what works.
- The playback timecode and timeline are still 30 fps (M1-033 / M1-034 use the sequence rate).
- HEIC stills depend on the browser.

## Test plan
Unit: classify, first-picture settings, op shapes, placement, labels. Smoke (desktop and phone): empty target, first import auto-add with poster/codec/resolution, `+` by keyboard, unsupported and non-media files, drop on the preview with overlay, paste, bin to timeline drag (desktop), no horizontal overflow.
