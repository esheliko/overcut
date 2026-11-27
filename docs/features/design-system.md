# Design system (M2 UX pass)

Source of truth: `apps/web/src/theme/tokens.css` (colours, type, radius, elevation, motion) and `theme/fonts.css` (self-hosted Inter). Components use tokens, never raw values.

## Rules
- **Type**: Inter variable (latin + latin-ext, SIL OFL, files and licence in `theme/fonts/`, no CDN). Scale `--text-2xs 11 / xs 12 / sm 13 / base 14 / md 16 / lg 18 / xl 22`. Weights 400 / 500 / 600; 700 only on primary buttons. Numerals that change (timecode, sizes) use tabular figures.
- **Lines**: `--line-strong` (control borders) is at least 3:1 on every surface (WCAG 1.4.11, pinned by `tests/unit/theme-contrast.test.ts`); `--line` is the quiet panel edge.
- **Radius ladder**: `--radius-xs` 4 keycaps, `--radius-sm` 8 controls, `--radius-md` 12 cards/panels/menus/toasts, `--radius-lg` 16 dialogs and sheets, `--radius-full` pills.
- **Elevation**: `--elev-1` cards, `--elev-2` menus/popovers/toasts, `--elev-3` dialogs/sheets. `--scrim` dims the app under dialogs in every theme (blur where supported).
- **Accent** is for the primary action, selection, focus and the playhead. Secondary actions are outline or ghost. The timecode is `--fg`.
- **Motion**: `--ease-out`, `--ease-in-out`; menus 120 ms, dialogs 180 ms, toasts 280 ms (opacity + translate only). Reduced motion zeroes durations and kills animation.
- **Icons**: one 24-grid, 1.7 stroke outline family in `icons.tsx`. The transport (play, pause, skip, frame step) is filled, everything else outline. No glyph characters (chevron, check, close) stand in for icons.
- **Menus**: 44 px rows on touch, 32 px with a mouse (`pointer: fine`); shortcut keycaps right-aligned, hidden without a keyboard.
- **Notices**: toast, saved-work notes and refusals share one surface and a status icon.

## Edge cases
- Disabled controls are 0.5 opacity (icon buttons are pinned at 3:1 by the contrast test).
- Canvas text uses `Inter`; `redrawWhenFontsLoad()` repaints the canvases once the faces are in.
- The Inspector reserves the keyframe interpolation row on every field once a clip has any keyframe, and range notes are overlays, so the form does not jump.
