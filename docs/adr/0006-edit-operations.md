# 0006 Edits are serializable operations with inverses
**Status**: proposed (validate with S7)

**Context.** Undo/redo, autosave, crash recovery, scripting and later collaboration are normally separate mechanisms that disagree with each other.

**Decision.** The project is changed only by applying `Op` values (small, serializable, deterministic) in `app-timeline`. Applying an op returns its inverse and a patch for the UI. The engine appends every op to a **journal**; autosave is a journal flush plus periodic snapshots; recovery replays the journal; undo applies inverses. Scripts, plugins and AI tasks emit ops like the UI does. Ops are designed to be mergeable (stable ids, position by anchor not by index) so a CRDT layer (M8) can be added without redesign.

**Consequences.** (+) one mechanism for five features, easy property testing. (-) every new edit needs an op + inverse + tests; granularity choices matter (drags are coalesced into one undo step). Direct mutation of project state outside `apply` is a bug.
