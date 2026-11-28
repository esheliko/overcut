# Feature: snapping (`app-timeline`, M2-009, TL-03)

## Behaviour
`snap(t, targets, tolerance) -> Snap` (`crates/timeline/src/snap.rs`) pulls a time to the nearest target within `tolerance` ticks (inclusive). Pure: no project, no allocation, one linear pass. Integer ticks only (ADR 0010).
- **Targets**: `playhead`, `marker` and `clip_edge` (both edges of every clip on every track, including locked and hidden ones). Ties: nearer wins, then playhead > marker > clip edge, then the earlier time. Tolerance < 0 or no target in range: no snap (`hit: null`, `time = t`).
- **Span** (`snap_span`): for a clip being dragged, either its start or its end may snap; the edge that moves less wins (start on a tie); the answer is the new START and the length is kept.
- **Magnetic mode** is the caller's switch: the UI calls `snap` while snapping is on (and while the user holds no override key) and skips it otherwise; the engine has no state for it. The tolerance is the UI's (a few pixels converted to ticks at the current zoom).
- **Markers**: the sequence's own markers and chapters (`docs/features/markers.md`) are targets automatically; the query's optional `markers` list adds extra times.
- Locked tracks are targets too (you may align to them), but snapping never edits anything: the result is only a time.

## Engine surface
`Editor::snap_json(sequence, params)` builds the targets from the live project (`targets_of`: clip edges except `exclude`, then playhead, markers) and answers, wired as `Editing.snap(sequence, query)` on both backends (wasm `Editor.snap`, Tauri `editor_snap`).
- Query `{ t, tolerance, playhead?, exclude?: ClipId[], markers?: number[], span? }` (ticks; `exclude` = the clips being dragged so they do not snap to themselves).
- Result `{ time, delta, hit: { time, kind } | null }`, `delta = time - t`.
- Errors (strings): bad sequence id, unknown sequence, malformed params.

## Performance
Budget: under 1 ms per snap at 20 tracks x 1000 clips. Measured (release, 40 001 targets): about 37 us for the search; building the target list per call adds one pass over the clips (microseconds to a few hundred us). If a drag ever shows it in a profile, cache the targets for the drag in the engine.

## Tests
`snap.rs` unit tests (tolerance edges, tie order, span, extremes, 20x1000 timing asserted in release builds), `editor_snap_json_*` in `tests.rs` (exclude, playhead, markers, span, errors), `tests/unit/editing.test.ts` (wire shape, input checks).
