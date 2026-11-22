# 0006 Edits are serializable operations with inverses
**Status**: accepted (validated by S7, see results below)

**Context.** Undo/redo, autosave, crash recovery, scripting and later collaboration are normally separate mechanisms that disagree with each other.

**Decision.** The project is changed only by applying `Op` values (small, serializable, deterministic) in `app-timeline`. Applying an op returns its inverse and a patch for the UI. The engine appends every op to a **journal**; autosave is a journal flush plus periodic snapshots; recovery replays the journal; undo applies inverses. Scripts, plugins and AI tasks emit ops like the UI does. Ops are designed to be mergeable (stable ids, position by anchor not by index) so a CRDT layer (M8) can be added without redesign.

**Consequences.** (+) one mechanism for five features, easy property testing. (-) every new edit needs an op + inverse + tests; granularity choices matter (drags are coalesced into one undo step). Direct mutation of project state outside `apply` is a bug.

## S7 results (M1-003, `app-timeline`)
- **Correctness**: two properties, `PROPTEST_CASES=100000` each (200k random sequences of 1-40/60 ops incl. undo/redo, release build, 10.5 s): `undo(do(x)) == x` per op and `replay(journal) == state` per sequence, plus undo-all/redo-all. All pass. The random test found one real bug while being written (a `SetClip` hopping a clip over a neighbour left the track unsorted); fixed by re-seating the clip. CI runs 256 cases (0.5 s).
- **Cost**: 2,000 mixed ops (move across tracks, trim in/out, split, delete) on a single 5,000-clip track through `History::apply` (journal + undo step included): **mean 9.5 us, worst 168 us** in release; mean 27 us in a debug build. Budget was < 1 ms (and <= 1 ms desktop / 8 ms low phone in `docs/PERFORMANCE.md`): ~100x headroom, from linear id lookup plus a `Vec` insert/remove, no index needed yet. Native numbers; the wasm figure is to be measured with the engine bench in M1 (expect 2-3x).
- **Granularity**: ops stayed simple (7 variants, inverses are 1-2 ops each); no structural sharing was needed. Open: compressing the inverse list of a long coalesced drag; recovering the undo stack (the journal restores the document only).
- Time is checked integer math; a fractional-tick speed scale is an error, not a rounding.
