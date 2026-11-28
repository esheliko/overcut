# Feature: project library (PM-08, M2-051)

Extends the projects list (`projects.md`, PM-06). Same screen (`Home.tsx`), same registry; this adds archive / restore, export and import to the per-project actions.

## Behaviour
- Per-project actions are in a **"…" menu** on each card (a 44 px button; opens with Enter/Space/tap; arrows, Home/End move, Esc or a tap outside closes and returns focus; scrolling or resizing closes it). Nothing is hover-only. Items: **Rename, Duplicate, Export…, Archive** (or **Restore** on an archived project), **Delete** (danger colour).
- **Archive** hides a project from the main list; it is never deleted (data untouched, only its list row gets `archived`). A note "Archived “X”. **Undo**" stays 8 s (dismissable). **Restore** is the same in reverse (also with Undo).
- **Filter** "Projects (n) | Archived (n)" appears only once something is archived (no clutter otherwise). Archived cards show "Archived <when>" and can still be opened and edited.
- **Export…** saves the project (not open: its latest state, a crash-left journal replayed first) as `<name>.overcut` through the same path as "Save project as…" (desktop dialog, Chromium picker, else download). Toast "Exported X.overcut". An unnamed project is exported as "Untitled project.overcut".
- **Import file…** (header; was "Open file…") adds a `.overcut` as its own project, never replacing the open one (unchanged PM-06 behaviour, new label). A file that is not a project, or from a newer version, is refused with the usual message.
- **Delete** keeps its confirmation ("cannot be undone"); it is the only action that is final. Archive is the reversible way to tidy up.
- **Empty states**: "No archived projects" (with how to archive, and Back to projects) in the Archived filter; "All your projects are archived" (with Show archived) when every project is archived.
- **First screen**: archived projects do not count. One active project opens straight in the editor; none active but some archived shows the library (a new project is never created behind the person's back).

## Data
- `ProjectEntry.archived?: number` (ms since epoch). Absent = active. `ProjectRegistry.update(id, {archived: undefined})` clears it. A stored non-number value reads as active (hand-edited or damaged file). Old lists without the field are valid, and older builds ignore it (the project then shows as active).
- `setArchived` only writes the registry (no project storage lock), so it works while another window has the project open. Export/duplicate need the project lock like before (`locked` error is shown).
- Pure helpers in `projectsView.ts`: `isArchived`, `libraryView`, `startScreen(active, archived)`.

## Edge cases
- Archiving then reloading keeps the state (list file). Undo after another action still works (it re-writes the row).
- Export of a project that was never edited exports its empty project. Two projects with the same name export to the same file name; the browser/OS disambiguates.
- Menu near the bottom/right edge flips above / stays inside the viewport; works at 320 px.

## Phone layout (R12)
Under 600 px each project is a compact 76 px row (poster 112 px on the left, text, the "…" menu on the right) so four to six projects fit one screen; from 600 px it is the 16:9 poster grid. Closing Rename / Delete returns focus to the card's "…" button. Measured (container, 4x CPU): 50 rows scroll at 16.7 ms per frame, 0 frames over 33 ms. `tests/smoke/phone-r12.spec.ts`.

## Tests
`tests/unit/projects.test.ts` (archive round-trip, damaged value, `libraryView`, `startScreen`), `tests/unit/rename-icon.test.ts`; `tests/smoke/project-library.spec.ts` (keyboard menu, archive/Undo/restore, Archived filter + empty state, survives reload, export is a zip, import round-trip, delete confirm; phone 44 px and no overflow); `projects.spec.ts` now drives actions through the menu.

## Not here
Collect / consolidate files (M2-052), thumbnails, bulk select, folders/tags.
