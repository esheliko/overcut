# Editor layouts (M1-030, UX-01)

One component set, five deliberate arrangements. The shell (`.editor`) is a CSS **size container**; `styles.css` re-arranges `.workspace` with `@container editor (...)`, so the layout follows the space the app really has (split view, foldable, embedded), not the window. `src/layout/profiles.ts` holds the same breakpoints and `profileFor(w, h)`; `useShellProfile` observes the shell and sets `data-profile` on `.editor` (used by React for what CSS cannot do: docked vs sheet tool panel, details column, compact top bar).

## Profiles
| Profile | Shell size | Arrangement |
|---|---|---|
| phone-portrait | < 720 px wide | preview / timeline / tool bar (bottom); tool panel is a bottom sheet; details via the Edit tool |
| phone-landscape | landscape, height <= 500, width <= 1000 | slim tool rail (left) \| preview over timeline; tool panel is a side drawer over the preview; compact top bar and lanes |
| tablet | 720-1099 wide | rail \| docked tool panel \| preview, timeline full width below; portrait gives the preview more height and a narrower panel |
| desktop | >= 1100 wide | rail \| tool panel \| preview \| details, timeline full width below |
| ultrawide | >= 1900 wide and >= 2:1 | desktop plus wider side panels (360 / 380) and a taller timeline |

The preview transport bar stacks (time + ratio over controls) when the preview itself is narrower than 640 px (`@container stage`), whatever the profile.

## Rules
- No horizontal page scroll from 320 px up; touch targets >= 44 px (tool bar and rail buttons, transport); safe-area insets on the shell, the landscape drawer, sheets and toasts; no hover-only controls.
- Profile is derived from the shell size, never from the user agent.
- The landscape threshold (height <= 500, width <= 1000) keeps a short desktop window (e.g. 1280x480) a desktop layout.

## Edge cases
- Resizing across a profile boundary keeps UI state (tool, zoom); only the arrangement changes. A sheet left open on a phone is simply docked on a tablet.
- 667x375 phones (below 720 wide) are landscape, not portrait.
- Foldables: unfolded inner screens land in tablet/desktop; folding re-runs the observer.
- Gaps: no dual-screen hinge-aware layout (see issue backlog), no user-resizable panels yet.

## Test plan
- `tests/unit/layout-profiles.test.ts`: `profileFor` for common devices and every breakpoint edge; CSS container queries match `BREAKPOINTS`; the grid is only re-arranged in container queries; safe-area insets present.
- `tests/smoke/smoke.spec.ts` ("layout profile ..."): seven viewports (320x568, 390x844, 844x390, 820x1180, 1024x768, 1280x800, 3440x1440): `data-profile`, preview / timeline / tools inside the viewport and not overlapping, inspector only >= desktop, docked panel vs sheet, landscape drawer, tool buttons >= 44 px, no horizontal overflow.
- Visual: `node scripts/shot.mjs "/" --w <w> --h <h>` per profile (screenshots in the PR).

## M2 UX pass (layout shell)
- **Phone portrait**: the stage is as tall as its picture (the canvas is capped at 38 dvh); the bar under it is one 52 px row (shape chip | transport | full screen), the playhead time rides on the picture's corner, the loop button on the other. The timeline takes all remaining height (about 350 px of canvas at 390x844). Bottom-bar tabs share the width.
- **Phone preview / timeline grab bar (UX r15 D7)**: in phone portrait a 44 px grab bar (`layout/PhoneSplitter.tsx`, `role="separator"`, arrows, Home/End, Enter or double tap resets) sits on the seam and sets `--pv-h`, the picture's height, on the workspace; the timeline takes the rest. The whole preview keeps >= 30 % of the workspace height and the timeline >= 260 px (`clampPicture` in `split.ts`, unit-tested); the size is kept as a share of the workspace height (`overcut.layout.phonePreview`). Projects with 3 or more tracks start with a smaller picture (26 dvh, 22 dvh on short phones; `data-tracks="many"`) so every track shows.
- **Phone app menu (UX r15 D8)**: "Saved on this device" is the only status line (no engine words; an engine failure still shows in the top bar), the theme is ONE row "Theme: Dark" whose choices and accent swatches show only while it is open, and the rest is a two-column grid of 44 px rows with no group headings; it is about 57 % of a 640 px phone and never scrolls. On touch phones the full screen button uses the app's own overlay (`stage[data-fs="overlay"]`), never `requestFullscreen` (Chrome's "press and hold to exit" notice covered the controls); desktop and tablets keep real fullscreen.
- **Phone landscape**: tool rail | preview | timeline side by side (48 / 52). The picture keeps the full height; the timeline toolbar hides the zoom -/+ and slider (pinch zooms).
- **Tablet portrait**: the tool panel is capped (26 dvh, max 300 px) and scrolls with a fade cue; the timeline row is `clamp(260px, 38%, 460px)`.
- **Splitter** (tablet and up, `layout/Splitter.tsx`): `role=separator`, drag, Up/Down (Shift = 96 px, Home/End), double-click or Enter resets; 44 px hit area on touch; the size is stored in `localStorage` (try/catch) and applied as `--tl-row` on the workspace.
- **Phone shell (UX r15)**: the Edit/Speed/Crop sheet opens at a **30 % peek** so the timeline ruler and playhead stay visible; opening it moves the playhead onto the selected clip when it is elsewhere (the picture shows what is being edited). The clip strip is `Back (compact chevron) | Split | Delete | Speed | Edit | Crop | Duplicate | Detach | Keyframe`; Edit always opens the Video tab, Speed the Speed tab, and the button that opened the sheet is the highlighted one. System **Back** steps out one level: clip selected -> deselect, sheet open -> close it, Projects (reached from the editor) -> back to the editor; it never leaves the app from the editor. The canvas dialog starts with a row of **ratio tiles** (16:9, 9:16, 1:1, 4:5, 21:9): one tap applies. The app is hardened like a native one: `overscroll-behavior: none`, `touch-action: manipulation`, no text selection or callout on chrome, no 1 px page scroll, apple-touch-icon and PNG manifest icons.
- **Portrait tablet (720-1099 px, portrait)**: the empty Media drop zone is one compact row so it fits the short panel above the preview; the timeline toolbar drops its zoom slider and scrolls inside itself instead of clipping; the timeline status chip is hidden below 1100 px.
- **Smooth-scrubbing progress** is a small ring in the player bar (after 0.9 s, only above 0 %), never on the picture; a full-screen preview hides it and the editing handles. **Toasts** sit just above the timeline (measured into `--toast-bottom`), never on the picture.
- **Collapse**: Media and Details fold to a 52 px strip (chevron in the header, state remembered). Details with no selection shows the canvas, length and clip count.
- **Phone sheet detents** (`layout/SheetHandle.tsx`, `sheet.ts`): small / half / full. Drag the handle (snaps by velocity; a flick down from small closes), tap steps up, Up/Down keys, Escape closes. Edit opens small with a mini transport (time, play, previous / next keyframe); Media opens at half. The height animates (not during a drag; none with reduced motion).
- Gaps: no vertical splitter between panels and preview; the sheet height transition animates `height` (short, one element).
