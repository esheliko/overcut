# Dragging clips on the timeline (M2)

**Behaviour.** Everything is a pure function in `apps/web/src/timeline/arrange.ts`, called by the gesture machine (`interact.ts`); the canvas only draws.
- **Move.** Mouse: press a clip and drag (the clip is selected on press). Touch: a tap selects, a drag on a *selected* clip moves it, a drag on an unselected clip pans; **press and hold ~0.4 s** on an unselected clip picks it up (short buzz where the device has one), and the next drag moves it. Keyboard: the existing nudge keys (`,` `.`, Shift = 10 frames).
- **Snap.** The selection's first start and last end are pulled onto the nearest clip edge on any track, the playhead and 0:00 within 8 px; a dashed accent line shows the snap point. `snapMove` is the single place to swap in the engine's snapping later.
- **Reorder.** Past the middle of a neighbouring clip the selection *jumps over it* (one neighbour per middle passed, either direction): the jumped clips pack against the side the selection left. A picture and its linked sound hop together while their neighbours are equally long; otherwise the move just stops against the neighbour as before. A guide line shows where the selection will land. Release applies park/shift/settle moves as ONE undo step.
- **From the media bin.** Drag a card onto the timeline canvas: a guide line follows the pointer (snapped like a move); dropping places the clip there, or after the last clip when that spot is taken (`placeAt`). Dropping elsewhere on the timeline panel still uses the playhead.

**Edge cases.** Locked tracks never move (a selection that is all locked says so). A hop is refused (plain move) when an unselected clip lies between selected ones on a track. Positions stay whole frames except where a snap target is not on a frame (a clip edge from another source).

**Tests.** `tests/unit/arrange.test.ts` (snap, hop planning, op replay, long press), `tests/smoke/drag-move.spec.ts` (mouse reorder + undo, short drag does not reorder).
