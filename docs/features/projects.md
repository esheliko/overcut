# Feature: projects list (PM-06, "Projects home")

## Behaviour
- Every project on this device is a row: name, last edit, canvas size, clip count. **No thumbnails**: a project that is not open has no rendered frame, so the card draws only its real canvas shape (aspect outline). Facts that are not known yet (a project never edited) are left out, never invented.
- Actions per row: open, plus a "…" menu with rename, duplicate, export, archive/restore, delete (see `project-library.md`). Delete always asks first ("cannot be undone"; media files on disk are untouched). Header: New project, Open file… (a `.overcut` becomes its own project; the open one is never replaced).
- First screen: the list when there are several projects, the only project when there is one, a new project when there are none (first start). Reachable any time from the app menu → **Projects** (leaves the open project cleanly: journal folded into its file).
- Menu **New project…** / **Open project…** keep their old meaning (replace the open project, with a version snapshot first, `canvas.md`); the list's buttons add projects instead.
- Empty state: "No projects yet — start a new project or open a .overcut file."

## Data
- `registry` storage (same backends as a project: OPFS / IndexedDB / Tauri folder) holds `projects.json` (atomic): `{v:1, current, items:[{id,name,created,modified,width?,height?,clips?}]}`. It only names projects; each project keeps its own storage (`persistence.md`). A damaged list reads as empty and never touches project data. Changes are one read-modify-write under a Web Lock.
- Project id: `p<time><rand>` (flat, `[A-Za-z0-9_-]`). Name "" = unnamed (UI shows the localized default). The topbar name now persists to the list.
- `modified`/canvas/clip count are written ~1.5 s after edits stop and when leaving, never on merely opening.
- **Migration** (`migrateSingleProject`): no list yet and project `default` has a saved file → it becomes the first row. Nothing is moved or rewritten, so autosave/recovery of that project are exactly as before; a crash-left journal is still replayed on open. Runs once; a list that exists is never re-seeded (a deleted project stays deleted).
- Duplicate opens the source through the normal recovery path (journal replayed), exports it and stores it as a new project. Delete removes file, journal, checkpoint, discarded log, snapshots and their index, then the row.
- If the list cannot be read (blocked storage) the app opens project `default` as before and saving reports the problem.

## Known limits
Native: a deleted project leaves an empty folder; the registry folder is `registry` in the projects folder. No thumbnails (a future export of a poster frame on close could add them). One window per project (lock) also applies to duplicate/delete.

## Tests
`tests/unit/projects.test.ts` (list, damaged file, migration incl. idempotence and byte-identical data, locking, delete, ids/copy names, view helpers); `tests/smoke/projects.spec.ts` (two projects, switch keeps canvas, rename, duplicate, delete with confirm, list is first screen after reload; phone 44 px targets and no overflow).
