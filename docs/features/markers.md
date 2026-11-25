# Feature: markers, chapters, in/out range (`app-model` + `app-timeline`, M2-007, TL-07)

## Behaviour
- A **marker** is a named point on a sequence's timeline (ticks, `>= 0`). `kind: "marker"` (a ruler flag) or `"chapter"` (also a chapter mark for export; the MP4/YouTube chapter output is lane B, M2-030). Optional `colour` `#rrggbb` (the track colour rule), name 0-120 characters without surrounding spaces (empty = unnamed). At most 10,000 per sequence.
- Markers live in `Sequence.markers`, kept ordered by (time, id), so two markers at one time have a stable order. Moving a marker re-sorts it.
- The **range** is `Sequence.range = { start, end }` (`0 <= start < end`, ticks, end exclusive) plus `Sequence.loop_range` (playback loops over it; needs a range). `None` = the whole sequence. The UI uses it for the in/out points, the render range and the loop range.
- Markers are **snap targets** (kind `marker`) for every snap call, with no extra input; the caller's optional `markers` list still works for extra times (docs/features/snapping.md). The range edges are not snap targets yet.
- Everything is an op, undoable, and part of the journal: one undo step each, a marker drag is one step under a coalesce key.

## Data model (schema 4)
`Sequence { markers?: Marker[], range?: TimeRange | null, loop_range?: boolean }`, all optional and not written when empty / false; `Marker { id, time, kind?, name?, colour? }` (`kind` absent = `marker`). Ids are 32 hex like every id (`MarkerId`); they share the document-wide unique id space.
Schema 3 -> 4 migration only bumps the version (fixture `crates/model/fixtures/project.v4.json`). `ABI_VERSION` and `EXPECTED_ABI` are 4.

## Ops (wire: `packages/engine-client/schema/edit-contract.json`, helpers in `editing.ts`)
| Op | Fields | Inverse | Refused with |
|---|---|---|---|
| `add_marker` | `sequence, marker` | `delete_marker` | `IdInUse`, `BadMarker` (time < 0, name, colour), `TooManyMarkers`, `UnknownSequence` |
| `move_marker` | `marker, time` | move back | `UnknownMarker`, `BadMarker` (time < 0) |
| `set_marker_props` | `marker, name?, kind?, colour?` (`colour: null` resets) | the old values | `UnknownMarker`, `BadMarker` |
| `delete_marker` | `marker` | `add_marker` | `UnknownMarker` |
| `set_range` | `sequence, range \| null, looping?` | the old range and flag | `BadRange` (start < 0, end <= start, looping with no range), `UnknownSequence` |
Markers are not clip edits: they can be added, moved and deleted on locked tracks, and editing clips never moves a marker (a ripple edit leaves markers where they are; moving them with the media is a later, explicit choice).

## Test plan
`crates/model` (`markers_and_range_are_checked_and_written_only_when_used`, the v4 fixture migration), `crates/timeline/src/tests.rs` (`marker_ops_keep_order_*`, `a_marker_drag_is_one_undo_step_*`, `markers_are_snap_targets_*`, the five ops in the S7 generator, wire contract), `tests/unit/editing.test.ts` (helpers equal the contract examples).

## Timeline UI (M2-046)
- **Add**: `M` or More > Add marker puts a marker on the playhead's frame (none if one is already there). **Ruler**: a flag (a diamond for a chapter) in the marker's colour, a thin line through the lanes, the name beside it when zoomed in.
- **Use**: tap or click jumps to it; dragging moves it by whole frames (one op on release = one undo step); tapping the marker the playhead already sits on, a long press, a right click, or More > Edit marker opens its menu (rename, 8 colours + default, chapter, delete; all 44 px). Grab zone 44 px on touch, 22 px with a mouse.
- **Range**: `I` / `O` set the in / out point at the playhead (the other end stays; no range yet = 0 / the end of the clips); the ruler shows a band, the lanes outside it are dimmed. More > Loop range toggles `loop_range`; `Alt+X` clears. **Play range** (`Alt+P`, More): the preview plays from in to out and stops, or loops; with no range it plays the whole sequence. The preview owns the player, so the timeline asks with `PLAY_RANGE_EVENT` (`commands/palette.ts`, handled in `PreviewPanel.tsx`).
- Everything is in the command registry (`marker.*`, `range.*`), the palette and the shortcuts dialog. Tests: `tests/unit/timeline-markers.test.ts`, `tests/smoke/markers.spec.ts`.
