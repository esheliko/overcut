# UX round 16, lane A: where media lands, no gaps, keyboard navigation

Evidence: `audit/{desk,first,phone}/report.md` of the round-16 journeys (build 7b116e4). Rules and behaviour: `docs/features/media-bin.md` ("Where media lands: one rule") and `docs/features/timeline-ops.md` ("UX r16 lane A").

## What changed (finding, before, after)

| ID | Before | After |
| --- | --- | --- |
| DESK-1, FIRST-2 | The card "+" and "Add to timeline" appended after the END OF THE PROJECT, so music longer than the pictures pushed every new clip past a long black hole on V1. Audio was appended after the video too. | One rule (`landingStart`): a picture goes right after the last picture on V1, so three clicks butt together; sound-only media goes at the playhead on a free audio track (a new one when A1 is busy). Same code for "+", Add to timeline, Enter, double-click, drag and import. |
| FIRST-3, PHONE-4 | A batch with music put the photo after the 30 s of music: a hole on V1 that exports black. | The V1 point is the end of the previous picture; sound-only files never move it and start with the batch (or at the playhead). |
| FIRST-1 | Importing music into a project that already had a clip only filled the bin ("Added to Media"), so "add music" ended in a silent export. | A sound-only file imported into a non-empty project goes straight onto the timeline (own audio track at the playhead). Videos and photos keep the toast, which now counts only what stayed in the bin. Double-click on a card adds it. |
| DESK-5 | A speed change left a hole although Magnetic was lit ("Move later clips to follow" was off); lifting a V1 clip to V2 left a hole. | The checkbox follows the Magnetic switch (until the person sets it), the keyboard speed commands ripple while Magnetic is on; a lift off the main track (drag or Alt+Up) closes the hole, and the linked sound moves to another lane and closes its hole too. One undo step. |
| DESK-7 | No jump to the next or previous cut or marker. | Up / Down: previous / next edit point (any track); Shift+Up / Down: previous / next marker. In the palette and the shortcut sheet (new "Markers" group). The preset keys do not clash (tested for all presets). |
| DESK-10 | Shift+click acted as Ctrl+click. | Shift+click selects the range from the last plainly clicked clip: same track, or the time range across tracks. Ctrl/Cmd+click toggles. |
| DESK-8 | Alt+Up on the top lane: "No free track there for this clip". | It makes a new video track above and moves the clip onto it (one undo step), as dragging above does; Alt+Down on the last audio lane makes an audio track. |
| DESK-11 | An 11 x 9 px flag; the double-click menu opened over the transport and hid Play. | A 14 x 12 px pennant (16 px diamond for a chapter) with the name beside it when there is room; the menu opens under the ruler and never above it, compact with a mouse. |
| DESK-9 | Two tab stops per media card (the timeline was stop ~41); Alt+T did nothing from the body. | The cards are one tab stop (roving tabindex): arrows, Home, End move, Enter adds, Shift+Enter adds as overlay, T or the context-menu key edits tags. Alt+T focuses the timeline from anywhere (the command had no handler: it was a no-op; Option+T on a Mac now matches by physical key). |

Screenshots (1440x900): `img/r16-a-lands.png` (three pictures butt on V1, the music on its own lane at the playhead; before: `audit/desk/shots/d-34-fit.png`), `img/r16-a-marker-menu.png` (named pennant flags, the menu under the ruler; before: `audit/desk/shots/rv-02-marker-dblclick.png`).

Tests: `tests/unit/r16-lane-a.test.ts` (landing rule, batch, lifts, jumps, keys, range select, new lane), `tests/smoke/ux-r16-a.spec.ts`. One stale assertion updated on purpose: `tests/unit/commands.test.ts` expected ArrowDown with no selection to scroll the tracks (`view.tracksDown`); it now jumps to the next edit point. A lift that leaves nothing to close (the last clip) keeps the sound where it is, so the existing `lanes.spec.ts` stays as it was.

## Cost
No per-frame work added except the marker flags (a path and, only when there is room, one `fillText`; the ellipsis loop runs only for a name that does not fit). The jump keys scan each clip once per key press; the lift plan is O(clips on the touched lanes) once per drop. Roving tabindex adds no listeners per card (one handler per card, as before for clicks).

## Not done (and why)
- Up / Down with a clip selected still move the selection between clips (the existing keyboard selection model); the edit-point jumps work with nothing selected (Escape first). Deliberate: changing it would break the clip-to-clip navigation.
- A marker list (DESK-7 mentioned "a marker list"): not started; the next / previous keys cover navigation.
- The marker name is not drawn in a background pill; lane E restyles the ruler.
- Lifting a clip with a linked sound moves the sound to another audio lane (a new one when none is free). That is the price of keeping sound and picture in sync while the hole closes; the sound can be moved back by hand.

## Notes for the other lanes
- `Command` has a new `{ c: "jump" }`; `view.tracksUp` / `view.tracksDown` have no default key any more (their keys became the jumps).
- `App.tsx`: the import `result` callback now carries `binOnly` (files that are only in the bin); toasts (lane toasts) should keep `media.addedToBin` for those only.
- `ShortcutsDialog.tsx`: `GROUPS` gained "marker". The sheet lane may want "range" and "media" groups too (not listed today).
- `styles.css`: a `@media (pointer: fine)` block for `.marker-menu` at the end of the file.
