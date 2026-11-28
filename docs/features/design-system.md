# Design system (M2 UX pass)

Source of truth: `apps/web/src/theme/tokens.css` (colours, type, radius, elevation, motion) and `theme/fonts.css` (self-hosted Inter). Components use tokens, never raw values.

## Rules
- **Type**: Inter variable (latin + latin-ext, SIL OFL, files and licence in `theme/fonts/`, no CDN). Scale `--text-2xs 11 / xs 12 / sm 13 / base 14 / md 16 / lg 18 / xl 22`. Weights 400 / 500 / 600; 700 only on primary buttons. Numerals that change (timecode, sizes) use tabular figures.
- **Lines**: `--line-strong` (control borders) is at least 3:1 on every surface (WCAG 1.4.11, pinned by `tests/unit/theme-contrast.test.ts`); `--line` is the quiet panel edge.
- **Shell (r14)**: flush panels separated by 1 px dividers (the workspace paints `--line` behind a 1 px grid gap); no floating cards, gaps or shadows between Media, Preview, Details and Timeline. Panel headers 38 px with a mouse, 44 px on touch. The preview sits on `--stage`. Dark is the default on a first run; an explicit choice (including "system") wins.
- **Timeline clips (r14)**: 60 px lanes, 6 px clip corners, full-bleed filmstrip, name and duration in dark chips, filled mirrored waveform, selection = 3 px accent border + white trim handles, 2 px playhead.
- **Radius ladder**: `--radius-xs` 4 keycaps, `--radius-sm` 8 controls, `--radius-md` 12 cards/panels/menus/toasts, `--radius-lg` 16 dialogs and sheets, `--radius-full` pills.
- **Elevation**: `--elev-1` cards, `--elev-2` menus/popovers/toasts, `--elev-3` dialogs/sheets. `--scrim` dims the app under dialogs in every theme (blur where supported).
- **Accent** is for the primary action, selection, focus and the playhead. Secondary actions are outline or ghost. The timecode is `--fg`.
- **Motion**: `--ease-out`, `--ease-in-out`; menus 120 ms, dialogs 180 ms, toasts 280 ms (opacity + translate only). Reduced motion zeroes durations and kills animation.
- **Icons**: one 24-grid, 1.7 stroke outline family in `icons.tsx`. The transport (play, pause, skip, frame step) is filled, everything else outline. No glyph characters (chevron, check, close) stand in for icons.
- **Menus**: 44 px rows on touch, 32 px with a mouse (`pointer: fine`); shortcut keycaps right-aligned, hidden without a keyboard.
- **Toolbar buttons** (`layout/ToolButton.tsx`): icon only, 36 px with a mouse, 44 px on touch. The tooltip (name + shortcut keycap, or the reason it is unavailable) sits on the wrapper, so a really disabled button still explains itself; it shows on hover and keyboard focus with a mouse only. Unavailable actions stay in place (opacity 0.38), never hidden. A toggle uses `aria-pressed` and the accent tint.
- **Phone tool strip** (`layout/ToolStrip.tsx`): icon above label, scrolls sideways, 64 px or wider targets; global tools with nothing selected, the clip's tools (first one is Back) with a selection. Property sheets open at about 45 % height (`layout/sheet.ts` peek) so the preview and the playhead stay visible.
- **Notices**: toast, saved-work notes and refusals share one surface and a status icon.

- **Values** (Details panel, r14): a numeric property is a slider plus a scrubbable number with its unit and keyframe diamond; related values sit in collapsible sections with sticky headers and a per-section reset. A slider drag or key press is one undo step. On touch each value is one 44 px row.
- **Media cards**: grid (16:9 poster, name under) or list, chosen with one toggle and remembered; "On the timeline" is a pill with a use count.
- **Export**: tiles that give the same file for the project are merged and named on one tile; the dialog shows the output's frame, with the size and length prominent.

## Edge cases
- Disabled controls are 0.5 opacity (icon buttons are pinned at 3:1 by the contrast test).
- Canvas text uses `Inter`; `redrawWhenFontsLoad()` repaints the canvases once the faces are in.
- The Inspector reserves the keyframe interpolation row on every field once a clip has any keyframe, and range notes are overlays, so the form does not jump.
