# Feature: version snapshots (PM-06)

Code: `packages/engine-client/src/persist/snapshots.ts` (store + retention), `apps/web/src/Versions.tsx` (sheet, auto snapshots), wiring in `App.tsx`. Tests: `tests/unit/snapshots.test.ts`, `tests/smoke/versions-bin.spec.ts`.

## Behaviour
- **App menu > Versions…** opens a sheet: a name field with **Save snapshot**, then the list (name or kind, time, size) with **Restore** and **Delete** (44 px targets), and a size note ("N versions use X on this device").
- **Automatic snapshots**: every 5 minutes of editing (only when the journal moved since the last one; checked every 30 s), and **before Open project / New project / a restore** (kinds `auto`, `before-open`, `before-new`, `before-restore`). An automatic snapshot byte-identical to the newest one is skipped. A snapshot that cannot be written is skipped silently: editing and autosave never wait for it.
- **Restore = replace the project, not an undoable op.** It goes through `ProjectSession.replaceProject` like Open, so the undo history starts empty (a replace op would have to carry the whole project in the journal). It stays safe: the current project is snapshotted first (`before-restore`), so a restore is reversed by restoring that entry. The bin's cards, timeline and preview follow through `store.reload()`.

## Storage and retention
Payload = the `.overcut` file from the same writer as Save (`session.exportBytes()`), stored beside the journal in the project's storage (OPFS, IndexedDB or the Tauri project folder: the `ProjectStorage` interface, no new backend) as `snap-<id>.overcut`, plus `snapshots.json` (list: id, time, kind, label, bytes, signature). Payload is written first, then the index (atomic replace), then pruned payloads are removed: a crash leaves at worst an orphan file, never an index entry without its payload. A damaged index lists nothing; the project is untouched.
Retention (`retain`): all `manual` snapshots, plus the newest 20 of the others (`MAX_AUTO`). Size: a snapshot is the project file (metadata, not media), typically a few KB to a few hundred KB; the sheet shows the total.

## Not covered
Snapshots are per project and local (no sync). With the multi-project list (M1-034) each project keeps its own folder, so they follow it. Diffing two versions is not built.
