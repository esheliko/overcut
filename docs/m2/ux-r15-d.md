# UX round 15, lane D: customer phone feedback (phone polish and two desktop items)

Source: the customer feedback batch from the M2 preview (Android phone + desktop). Branch `ux-r15-d` (from `ux-r15-a`). Screenshots: `SCRATCH/r15/d/` (390x844 and 360 wide; desktop 1440x900), before and after.
Every item below was reproduced in Playwright at the stated device first (Chromium, `isMobile` + `hasTouch`, deviceScaleFactor 2 for phone shots).

| # | Item | Before | After |
|---|------|--------|-------|
| 6 | Touch: dragging a selected clip when meaning to scroll | A drag on a SELECTED clip body picked it up and moved it (`press("move")`); only unselected clips scrolled | On touch a drag on a clip body, selected or not, ALWAYS pans; moving needs the long press (380 ms, lifted ghost), which keeps a multi-selection. Trim handles of the selected clip still drag at once; mouse unchanged. Stale unit test rewritten (`timeline-edit.test.ts`, said so in its title); `timeline-view.md` updated |
| 4 | "Files are missing" on Android | Note "1 file is missing." + "Choose files…", frame "Media missing" for a file that can never survive a reload | Note "Files are not kept after a reload." + ONE action "Choose files again"; frame "Choose this file again"; bin-wide button "Choose all N files again..."; card keeps the designed sentence. Desktop handles with lapsed permission still say "Needs permission" |
| 3 | Giant phone toasts with the X on its own line | 360 px: note 108 px tall (text, action, then the X alone on a third line); the recovery note 3 rows | Every note is one row, 50 px at 360 and 390: icon, text (2 lines max), accent text action, 44 px X at the end. A failure with details keeps its expander on a row below |
| 8 | Phone main menu | 1027 px of content (scrolled), 570 px visible on a 640 px phone; 4 theme rows + swatches always open; green engine status | 368 px (57 % of 640), no scroll: "Saved on this device" is the only status, theme is one row "Theme: Dark" (choices and swatches only while open), two-column grid of 44 px rows, no group headings |
| 5 | Snap not reachable on phones | Magnet and ripple switches hidden <= 720 px, no other way | "Snapping" and "Ripple edits" are `menuitemcheckbox` rows at the top of More on a narrow bar, state On/Off visible, menu stays open |
| 9 | Android fullscreen notice covers the controls | `requestFullscreen` on every device | Touch phones (coarse pointer, short side <= 500 px) use the app's own overlay; desktop/tablet keep real fullscreen |
| 7 | Phone timeline too short for 3 tracks | Fixed 38 dvh picture; at 390x640 the timeline was 257 px | 44 px grab bar on the seam (drag, arrows, Home/End, Enter resets, remembered as a share of the height); 3+ tracks start with a smaller picture: timeline 257 -> 308 px at 390x640, 341 px after a 100 px drag; preview >= 30 %, timeline >= 260 px (unit-tested clamp) |
| 2 | Filter and sort panel huge | Inline panel pushed the cards down (4 chips + 2 selects, 44 px rows) | Popover anchored to its button: `--elev-2` menu surface, 280 px, rows 32 px (mouse) / 44 px (touch), cards do not move, test ids kept; Esc / outside tap / button closes |
| 1 | Theme button not recognisable | Half-circle icon (`theme`) | Sun on a light screen, moon on a dark one (new `sun` / `moon` icons, 24-grid 1.7 stroke); tooltip "Theme"; same icon on the phone menu row |

## Changed behaviour in existing tests (stale, not skipped)
- `timeline-edit.test.ts`: the touch test encoded "dragging a selected clip moves it"; it now asserts pan, then a long press arms the move and keeps the selection.
- `phone-r12.spec.ts` (note + frame wording), `relink-all.spec.ts` ("Choose all 2 files again"), `appearance.spec.ts` and `smoke.spec.ts` (the phone menu's theme choices sit behind the one Theme row), `media-bin.spec.ts` / `versions-bin.spec.ts` (Filter rows are 32 px with a mouse; the popover closes when a card is tapped, so the tag filter is reopened), `menu-labels.test.ts` (no engine status in the menu any more; the dead keys `engine.starting` and `engine.menu.ready` are removed).
- New: `tests/smoke/ux-r15-d.spec.ts` (note row at 360/390, menu height, switch rows, overlay fullscreen, grab bar, Filter popover, theme icon) and `tests/unit/phone-split.test.ts`.

## Cost
No hot-path change: the grab bar writes one CSS variable per frame while dragging (no React renders); `Timeline` subscribes to the two switch stores (re-renders only when one is flipped). No engine or ABI change.

## Left out
- Touch long-press hint (a first-time "hold to move" tip) is not added; the lifted ghost and the haptic buzz already show the pick-up.
- The phone More sheet itself is still long (lane A owns its content); the two switch rows are first in it.
