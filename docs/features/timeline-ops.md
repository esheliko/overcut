# Feature: edit operations (`app-timeline`, M1-003 / spike S7)

## Behaviour
The project changes only through `apply(&mut Project, Op) -> Result<Inverse, OpError>` (ADR 0006). `Op` is a serializable enum addressed by id: `InsertClip`, `Split`, `TrimIn`, `TrimOut`, `Move`, `Delete`, `SetClip` (exact geometry; used by inverses, also a valid edit). New ops (M2 ripple/roll/slip/slide) are new variants (`#[non_exhaustive]`, JSON tag `op`) with their own inverse.
- **Validation before mutation**: unknown ids, locked track, new id already in the document, video/audio kind rules, `duration > 0` (in < out), `start`/`source_in >= 0`, speed > 0, source range inside the media (when its duration is known), no overlap on the destination track (touching is fine), no tick overflow. An error leaves the project byte-for-byte unchanged.
- **Ids come from the caller** (`InsertClip.clip.id`, `Split.new_id`): replaying the same ops on the same base gives the same state, and ops stay mergeable (M8).
- **Source offsets** scale by `speed` exactly; a speed that would need a fraction of a tick is refused (`InexactSpeed`), never rounded (ADR 0010).
- `Inverse` is a list of ops applied in order: insert -> `[Delete]`, delete -> `[InsertClip]`, move -> `[Move back]`, trim/`SetClip` -> `[SetClip old]`, split -> `[Delete right, SetClip left-old]`.
- `apply_all(ops)`: all-or-nothing; a failing step rolls the earlier ones back and the error names the index.

## History and journal
- `History::apply(project, op, coalesce_key)`. Consecutive ops with the same `Some(key)` share one undo step (a drag is one Ctrl+Z). A new edit clears redo. `with_limit(n)` caps undo steps (journal is never trimmed).
- **Journal** = every op that changed the project, in order, *including* the ops that undo and redo apply, so `replay(base, journal) == state` has no special cases. JSON Lines (`journal_to_jsonl`/`journal_from_jsonl`; a torn last line is dropped, an earlier bad line is an error). Recovery restores the document, not the undo stack.
- A coalesced step keeps every inverse (undoing a 200-event drag applies 200 small ops); compressing same-clip runs is a follow-up if it ever shows up in a profile.

## Engine surface
`Editor` (JSON in, JSON out) wraps project + history; `crates/wasm` (`Editor` class), `apps/desktop/src-tauri` (`editor_*` commands) and `Engine.editing` (`packages/engine-client`, shared `createEditing` over both backends) all forward to it. Wire format pinned by `packages/engine-client/schema/edit-contract.json`, tested in Rust (`wire_format_matches_the_checked_in_contract`) and TS (`tests/unit/editing.test.ts`). `EditOutcome { revision, can_undo, can_redo, changed }` is returned after each call; the UI re-reads `project()` (a real patch stream is M1-034). UI wiring is out of scope here. `ABI_VERSION` is not bumped: the change is additive.

## Test plan (`crates/timeline/src/tests.rs`)
Property tests (proptest, seeded op generator that resolves against the live project, ~76% of ops apply and all 7 kinds succeed): (1) every op: Ok keeps `validate()` true and `apply(inverse)` restores exactly, redo reproduces; Err changes nothing. (2) random op/undo/redo sequences: each undo returns to the recorded earlier state, `replay(journal) == state`, undo-all == base, redo-all == final. Unit tests: every validation rule, locked tracks, split/trim source maths, inexact speed, batch rollback, drag coalescing, redo clearing and the step limit, torn journal, JSON API. Perf test at 5k clips.
Run the S7 bar: `PROPTEST_CASES=100000 cargo test -p app-timeline --release`. CI runs the default 256 cases.
