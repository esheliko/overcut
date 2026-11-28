# UX round 16, lane C: shell, phone layout, menus, toasts, home, tokens

Evidence: the round-16 audit reports (`desk`, `phone`, `first`). Behaviour: `docs/features/editor-layouts.md` (new r16 section). Screenshots: `docs/m2/img/r16-c-*.png`.

## What changed (finding, before, after)

| ID | Before | After |
| --- | --- | --- |
| PHONE-1 | A selected overlay could be moved or scaled on the picture only while the Edit sheet was open; pinch did nothing. | The gizmo shows whenever a visual clip is selected. One finger drags, two fingers pinch to scale and rotate (one undo step per gesture), a tap outside the frame deselects. Pinch on an empty preview does nothing. Smoke: `ux-r16-c.spec.ts` (pinch, tap outside). |
| PHONE-3, PHONE-13 | The 200 px Edit sheet showed only a header and a duplicate Play row; the expanded sheet hid the picture and timeline; landscape Details covered the picture; the 9:16 picture was 82x146 px. | The shell reflows above the open sheet: picture and the selected clip's lane stay visible, the peek sheet shows Position X / Y, the Play row is gone, full keeps a picture strip, landscape docks the sheet in a column beside the picture and timeline. Idle 9:16 picture 82x146 -> 112x199 px at 390x664 (+82 % area). `r16-c-phone-sheet-before/after`, `r16-c-phone-landscape-sheet-after`. |
| PHONE-2 | Back with the app menu or the timeline More menu open left the app. | Both menus are history layers like the sheets. A layer opened while another layer's `history.back()` is in flight now waits for it (a menu that closes as its dialog opens). Unit test in `phone-layers.test.ts`, smoke step. |
| DESK-4 | Timeline 30 % of the editor, 4 lanes did not fit; invisible splitter. | 40 % by default, up to 50 % with the track count, unless the user dragged; always-visible grab pill with hover and drag states (`r16-c-desktop-timeline-after`). |
| FIRST-8, PHONE-12, DESK-8 | Toast over the player transport; 7 s for an action toast. | Toast sits above the player bar (desktop and tablet) or above the sheet or timeline (phone), opaque surface; action toasts 5 s, plain 3 s (up to 5 s for long text). |
| FIRST-7 | Tooltip text ran out of its box. | Tooltips wrap, up to `--tip-max` 320 px. Toolbar toggles are named "Snap" and "Ripple edits" with the explanation as a second line. |
| FIRST-11, PHONE-14 | More: 24 rows, 8-11 greyed, 240 px wide, opened upward under the top bar. | Clip rows are hidden while nothing is selected (Paste stays, saying why). 280 px wide, opens downward, else on the side with more room, with an internal scroll (`r16-c-more-menu-after`). Test updated: `clipboard-history.spec.ts` (hidden, not disabled). |
| FIRST-5, PHONE-15 | Full-bleed "New project" bar on desktop and tablet (`.home-fab` lost to `.export-go`); poster cropped; a duplicate was not shown. | FAB phones only; "New project" is the first grid tile elsewhere (`r16-c-home-tile-after`); poster `contain` (no crop of a vertical project); the duplicated project glows for 3 s and scrolls into view. Test updated: `project-library.spec.ts`. |
| FIRST-12, PHONE-11 | 768 toolbar overflowed; media names broke mid-word; 36 px targets on tablet; landscape bar overflowed with tools duplicated in the rail. | Tablet: selection chip hidden below 820 px, zoom slider below 800 px; targets stay 44 px up to 1100 px; names break after `_`, `-`, `.`; landscape bar keeps undo, redo, tools, More, Fit (clip ops and the snap switches move into More). |
| FIRST-10 | "Set by your first clip" shown with clips; no selected shape tile; native selects. | "Matches your first clip: ..." when clips exist; the tile of the matching shape is marked selected; selects restyled to the app's menu look (custom chevron, hover). |
| Tokens | 11 px text, five disabled opacities, no hover/press, ad hoc z-index. | `--text-2xs` 12 px, `--disabled-opacity`, `--surface-hover/-press/-4`, `--accent-hover/-press/-text`, `--z-sticky/-menu/-tip/-toast/-dialog` (toast, tip and menu use them), `--tip-bg/-fg/-max`, `--clip-video/-photo/-overlay` and `--clip-ink` (4.5:1 in every theme; unit test). 12 disabled rules use the token. `draw.ts` untouched. |
| FIRST-9 | After a reload: banner, preview prompt, a long text and button on every card, a stray icon button. | One banner with one button; cards show a short "Missing" badge and no button; the "Choose all" bin button no longer appears for files a reload dropped. The preview's one-file prompt stays (it is on the picture, and `phone-r12.spec.ts` covers it). |

## Cost
No per-frame work added. The pinch uses 4 capture listeners on the stage view only while a gizmo is mounted. The splitter's auto height is one `ResizeObserver` callback writing a CSS variable. The sheet reflow changes layout when the detent changes, not on every drag frame.

## Not done (and why)
- Segmented controls in the canvas dialog: seven smoke specs drive the native `<select>`s; they were restyled instead of replaced.
- Keeping the selected lane scrolled into view when the sheet shrinks the timeline: that is `TimelineCanvas.tsx` (lane E). On a many-lane project the visible lane is the one the canvas last had at the top.
- Hover/press tokens are defined, not yet applied everywhere; hand-rolled z-index values outside toast, tip and menu are untouched.
- The preview "Choose file" prompt is kept for reopened files (see FIRST-9).

## Notes for the other lanes
- Lane E: `--clip-video/-photo/-overlay`, `--clip-audio` and `--clip-ink` are ready for `draw.ts`. With the phone sheet open the timeline can be only ~120 px tall: scroll the selected clip's lane into view on a height change.
- `inspector.keyNext` / `inspector.keyPrev` are unused catalog keys and fail the "no dead strings" unit test on `m2` already (not touched here).
- `MiniTransport.tsx` was deleted; the Details sheet no longer has its own Play row.
