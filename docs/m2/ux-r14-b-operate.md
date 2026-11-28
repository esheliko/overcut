# M2 UX round 14, lane B: operate it (toolbars and phone)

Goal: the actions for what you selected are one click or tap away, as in CapCut.

## What changed (before → after)
- **Desktop / tablet timeline toolbar.** Before: Undo, Redo, Split, Delete, then the text menus `Select ▾` and `More ▾`; Speed, Duplicate, Ripple delete, Overlay were buried in More. After: icon toolbar `Undo Redo | Split Delete Ripple-delete Duplicate | Speed▾ Crop Unlink Overlay | Edit-tool▾ More▾`, and on the right the selection pill, a **Snapping** toggle and the zoom. Every button has a tooltip (name + keycap, or the reason it is unavailable); unavailable actions are really disabled and stay in place.
- **Edit tool.** `Select ▾` text is now an icon button that shows the current tool's icon (tinted when not Select); the same menu (all five tools) opens from it.
- **Speed** opens a menu of the presets (0.5×, 1×, 1.5×, 2×, same edit and undo step as the Speed tab) plus "Custom speed…" which opens the Details Speed tab. **Crop** opens Details and puts the cursor in the first crop field (`layout/toolStrip.ts`: `requestDetails`, works for the docked column, the tablet panel and the phone sheet).
- **Snapping toggle** (new, `timeline/snapStore.ts`): turns off the pull to clip edges and the playhead while dragging; kept on this device. Default on.
- **Phone bottom strip** (`layout/ToolStrip.tsx`): before only Media | Edit. After: nothing selected → Media, Overlay, Split, Canvas, Edit; a clip selected → Back (deselect), Edit, Split, Speed, Crop, Duplicate, Delete, Detach (linked clips only), Keyframe. Icon above label, scrolls sideways, targets ≥ 44 px. The duplicated clip icons are hidden from the top toolbar on the phone (Undo/Redo, tool picker, More and Fit stay).
- **Phone property sheets** open at about 45 % (`layout/sheet.ts`, peek 45 % / half 62 % / full); the drag handle still expands.
- Keyboard shortcuts, the palette and back-button handling are untouched (the strip sends the same commands through `COMMAND_EVENT`).

Screenshots: `docs/m2/img/r14-b-*.png`.

## Left out
- **Freeze frame**: there is no engine operation for it (it needs a still clip made from a source frame: an ADR and an `app-timeline` op, not UI work). Not faked.
- **Fixed centre playhead on the phone**: does not fit `view.ts` / `TimelineCanvas.tsx` cleanly (scroll is clamped at 0, pan and scrub swap roles, ~10 direct `scrollX` writers, painting is lane A's). Reasons and proposal in issue #250.
- **Volume / Audio tool** in the strip: the Audio tool is not built yet (M3).
- Follow-playhead toggle: no such setting exists yet; only Snapping was added.
- Lane C is restructuring the inspector: Crop's focus is best effort (it looks for `insp-crop_left`); if that group is collapsed the sheet just opens.

## Cost
No per-frame work: the toolbar re-renders with the same triggers as before; the snap toggle subscribes on its own; tooltips are CSS. Snapping reads one boolean per drag move.

## Tests
Unit: `tests/unit/tool-strip.test.ts` (strip modes, sheet detents). Smoke updated where it asserted old chrome (see PR).
