# Feature: project persistence, autosave and crash recovery (M1-040)

## Behaviour
Every committed edit is durable within one flush (a few ms) of being made; a crash, a killed tab or a dead Worker loses nothing that was acknowledged. On the next open the app restores the project and its undo history by itself and shows a small, non-blocking note **"Recovered unsaved changes"** with **Undo recovery** (back to the last clean save; the discarded edits are kept in `discarded.jsonl`, never deleted silently).

The project id is no longer fixed: the list (`projects.md`) names projects; the old single project keeps the id `default`.

## Files (per project; one folder natively, OPFS directory or IndexedDB rows on the web)
- `project.overcut`: the project as the session began (the last clean save). Replaced atomically, only on a clean close.
- `journal.jsonl`: a header line `{"header":1,"base":"<crc32>:<len>"}` naming the base, then one **commit record** per line, appended after every edit. Append-only; a crash can only tear the last line.
- `checkpoint.json`: same header, then `{"seq","project"}`; a full snapshot written atomically after 3 s idle or 500 records. Fallback only.
- `discarded.jsonl`: the journal of an "Undo recovery".
The `.overcut` zip keeps its reserved `journal` entry unused: a zip cannot be appended to per edit, so the live journal is a sidecar. Folding it into the zip is a follow-up.

## Commit records (engine, `crates/timeline/src/recovery.rs`)
`{"n":1,"r":"apply","ops":[..],"key":7}`, `{"n":2,"r":"undo"}`, `{"n":3,"r":"redo"}`; `n` counts from 1 without gaps. `Editor::take_log()` returns the lines produced since the last call; `Editor::recover(base, checkpoint, log)` replays them through `History`, so **the undo stack is rebuilt, not just the document**: undo reaches back to the start of the crashed session (the ops-only `journal()` of M1-003 cannot do that, undo/redo there are inverse ops). Recovery keeps the longest valid prefix: the first unparsable, out-of-sequence or inapplicable line ends the replay and the rest is reported as `dropped`. Checkpoint fallback (`full_history: false`) is used only when the base cannot be replayed to the checkpoint; undo then reaches back to the checkpoint, and an undo of a pre-checkpoint step ends the replay there.

## Host (`packages/engine-client/src/persist`)
- `ProjectSession` wraps `Engine.editing`: after each `apply/undo/redo` it schedules a flush (`takeLog` then `append`). `whenDurable()` resolves when everything so far is on disk: that is what "acknowledged" means. A failed append keeps the records in memory, reports `error` (a `StorageError` with a user-facing message: `quota`, `permission`, `unavailable`, `locked`, `io`), retries every 2 s, and repairs a torn line (truncate to the last whole line) before appending again. Nothing is dropped silently.
- `close()` (on `pagehide`, best effort): write `project.overcut` atomically, then delete journal and checkpoint. A crash between the two leaves a journal whose header base no longer matches the project: it is recognised as stale and discarded, never replayed onto the wrong base. If the browser cuts `close()` short the journal is still durable and the next open shows the recovery note (harmless).
- Storage backends: **OPFS** in a dedicated Worker (`persist/worker.ts`; sync access handles, `flush()` per append), **IndexedDB** where sync access is missing (older Safari; each append is its own record), **Tauri folder** (`crates/store`: temp file + fsync + rename, fsync on append; `store_*` commands), memory (tests). OPFS has no portable atomic rename, so atomic replace is a two-slot scheme (`magic, generation, length, crc32, payload`; write the slot that does not hold the newest valid copy, read the highest valid generation); a torn write only damages the older slot.
- UI side (M1-024): the shared project store attaches to `session.editing` (and re-reads it when **Undo recovery** replaces the project, `epoch`), so the bin, timeline and preview all follow recovery, undo and redo; the store is fed only by `Engine.editing` outcomes.
- `navigator.storage.persist()` is requested when a project is first created. `acquireProjectLock` (Web Locks) allows one window per project.
- Open path: no `project.overcut` -> create; journal with records for this base -> `Editing.recover` -> note; otherwise `Editing.open` and clear stale files.

## Replacing the project (Open / New project)
`ProjectSession.replaceProject(bytes)`: the engine parses the file first (a refused file changes nothing); then the new bytes are written atomically as `project.overcut` BEFORE the old journal and checkpoint are removed, so a crash in between leaves a journal whose header base no longer matches: recognised as stale and discarded, never replayed onto the wrong project. Then `Editing.open`, the session's base is the new file, undo history starts empty. `exportBytes()` is the live project in the file format (Save project as).

## Media fingerprints and relink (host)
`Engine.fingerprintMedia(size, first, last)` (wasm `media_fingerprint`, Tauri command of the same name) and `fingerprintFile(engine, file)` read at most 128 KiB of any file. `SetMedia { media, uri, hash }` is the op that records a fingerprint on import and updates a moved file's uri (undoable, journaled). `relinkMedia(engine, project, candidates, current)` implements the relink steps of `project-file.md`: keep what still matches, else find a same-size candidate with the same fingerprint (each file hashed once) and return `set_media` ops, or list the media as offline (references and clips stay). Folder scanning and the import UI are M1 import work; they call these.

## Numbers (reference machine: this CI container, Chromium, OPFS)
- Autosave: one journal append per edit burst: 9 appends for a 41-op session, slowest 7 ms (opens a sync handle per append; a cached handle is a follow-up if it shows up).
- Engine side: log line serialisation is part of `apply` (< 1 ms at 5k clips, S7 bar unchanged).
- Recovery: 20,000 records (3 MiB of log) replay in ~40 ms (release build).

## Tests
- `crates/timeline`: `recovery_restores_the_document_and_the_whole_undo_history`, `a_log_cut_at_every_byte_recovers_a_prefix_state` (torn write at every byte), corruption/out-of-sequence prefix, checkpoint fallback, `SetMedia`, recovery time.
- `crates/store`: crash at many points of a replace keeps the last good file; torn append keeps what is before it; names cannot escape the folder.
- `tests/unit/persistence.test.ts`: session over a stand-in engine with fault injection: acknowledged = recovered, torn append, stale journal after a half-finished close, quota error surfaced and healed, two-slot replace torn at every byte, Undo recovery, fingerprints and relink.
- `tests/smoke/persistence.spec.ts`: real engine and real OPFS in Chromium: edit stream, terminate the Worker mid-stream, reload, state equals the last acknowledged op, undo reaches the session start, Undo recovery.

## Not covered / follow-ups
Tauri commands are compile-checked by `desktop-check` only (no webview in CI). Raw IPC bodies instead of number arrays for large bytes. Multi-project list: done, `projects.md`; open/save-as is in the app menu (`canvas.md`). Folding the journal into the zip entry. Cached sync handle for appends.

## M2 UX r16 (lane B): Save now and the project name
- **Save now** (`App.tsx saveNow`): `session.whenDurable()` then `checkpoint()`; Ctrl/Cmd+S, the "Save" menu row and a click on the save chip all do it. The chip reads "Saved just now" for 2.5 s, then "Saved on this device". Autosave is unchanged; "Save project as..." is the file copy.
- **Project name**: written to the library on input (400 ms pause), on Enter / Go and on blur, so a reload right after renaming keeps it.
