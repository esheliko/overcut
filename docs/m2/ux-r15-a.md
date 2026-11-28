# UX round 15, lane A: timeline editing and operating

Evidence: `audit/desk.md`, `audit/first.md`, `audit/phone.md` of the round-15 journey simulation. Rules and behaviour: `docs/features/timeline-ops.md` (new section "Trimming at a cut, the magnetic main track, link, new tracks").

## What changed (finding, before, after)

| ID | Before | After |
| --- | --- | --- |
| DESK-1 | Every drag within 16 px of a cut between touching clips started a roll; with no spare footage it only showed "No extra footage to roll". Trimming by dragging was impossible on fresh imports. | The pointer's side picks the clip: left of the cut trims the left clip's end, right of it the right clip's start. Roll is the Roll tool (N) or Alt-drag, with a two-clip ghost. Unit test `timeline-edit.test.ts`. |
| FIRST-2 | Trimming or deleting on the main track left a gap that exports as black, with no sign. | Magnetic main track (toolbar toggle, `Alt+G`, on by default): trims and Delete on the lowest video track ripple (with the linked sound). Gaps anywhere are hatched on the main track. `gapSummary` / `projectGapSummary` for lane C's export warning. |
| CUST-3 | Reported: a linked pair could only move in time. | Already handled by `lanePlan` (r14): the picture takes the drop lane, the sound keeps its track or the first free audio track, link and offset kept (tests in `timeline-lanes.test.ts`). No engine change needed. |
| CUST-6 | Unlink had no way back. | Link (select a picture and a sound, Link): toolbar (toggles with Unlink), More, palette, `Ctrl/Cmd+L`. Uses `set_link`, one undo step. |
| DESK-3, CUST-4 | The "Drop media here" zone appended to V1; adding a track was hidden in More. | Dropping a card on the top strip of the first video lane or under the last track makes a new track first (insertion line and "New track" label while dragging). Visible "+ Video" / "+ Audio" buttons under the track column. |
| CUST-5, FIRST-11, DESK-16 | Toolbar of 12 icons, More with 25 rows and second lines of reasons, jargon, native tooltips on zoom. | Toolbar: Undo, Redo, Split (with label above 1100 px), Delete, Duplicate, Speed, Link/Unlink, tool, More. More has Clip / Track / Range and markers / View sections with plain words ("Start and length…", "Delete and close the gap", "Start the range here"). Disabled reasons are the row tooltip (mouse) and stay as a line only on touch screens. Zoom buttons use the shared tooltip ("Zoom out (-)"). |
| DESK-4, DESK-7, FIRST-12 | Zoom, Ctrl+A, Enter, Esc, brackets and arrows only worked with the canvas focused; Shift+Right was a second on the canvas and a frame elsewhere. | One document-level listener runs the canvas commands from any focus except text fields, sliders, menus, dialogs, tabs and a button's Enter/Space. The preview's own arrow/Home/End handling was removed so one key is one step. Palette gained Import media (`Ctrl+I`), Link (`Ctrl+L`), Snapping (`Alt+S`), Magnetic main track (`Alt+G`), Add video / audio track, Focus the timeline (`Alt+T`). Unavailable commands already sort last (r14). |
| CUST-2 | Dragging the preview/timeline splitter blanked the timeline (resizing the backing store clears it; the repaint came one frame later). | The ResizeObserver callback repaints synchronously (it runs before paint), so no blank frame. |

## Cost
No per-frame allocation added: gap ranges are cached per scene (`WeakMap`), hatching is one path per visible gap, the add-track buttons are two rounded rects per frame. The document key listener does a `closest()` only on key presses. Perf baseline (60 fps, 0 long tasks on 128 and 1000 clips) not re-measured in this lane; the paint changes are bounded by the visible lanes.

## Not done (and why)
- DESK-6 (timeline panel default height), DESK-12/FIRST-10 (selection count wording), DESK-13 (marker look, next/previous marker), DESK-20 (lane height and header icons), PHONE-13 (back-to-playhead chip), PHONE-17 (press feedback on clip tap), PHONE-20 (frame step repeat on hold): not started, out of budget for this round.
- Dragging an existing clip onto the empty area to make a new track (DESK-3, second half) and a ghost clip at the drop point for bin drops: the drop line and lane tint exist, the ghost needs the dragged media's length during dragover, which the bin's drag payload does not carry (lane B owns the payload).
- "Follow playhead" toggle (DESK-7): there is no such mode yet, so no command.
- A video card dropped in the bottom zone makes its new video track at the TOP of the stack (video tracks cannot sit under audio); the insertion line is drawn where the pointer is.

## Notes for the other lanes
- Lane B: `PreviewPanel.tsx` no longer steps on ArrowLeft/ArrowRight/Home/End (the timeline's document listener does, with the canvas semantics); `Timeline` has a new optional `onImport` prop (App passes `importFiles`) for `Ctrl+I`; `onDropMedia` is wrapped in `Timeline` for new-track drops (the callback is still `(id, tick, track?)`).
- Lane C: `projectGapSummary(project)` in `apps/web/src/timeline/gaps.ts` returns `{ count, seconds }` for "Your timeline has N gaps".
