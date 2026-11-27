# M2 UX round 11, lane "shell" (first impression and coherence)

Method: `npm run build` + `vite preview`, Playwright (Chromium) at 1440x900 mouse, 390x844, 320x640 and 820x1180 touch, dark and light: empty editor, import of real fixtures (`crates/media/tests/fixtures`), command palette, shortcuts dialog, Menu, Projects home with two projects, project "…" menu, Privacy, Versions, the error screen (`?e2e&force-error`), Media sheet on phone. Every step: horizontal overflow, console errors and warnings, targets under 44 px on touch. Result at every size: no overflow, no console error, no touch target under 44 px on phone. The ui-ux-pro-max reference docs (`pro-rules.md`, `quick-reference.md`) were read; the skill's `search.py` was not run here (the sandbox refused to run the downloaded script), so the yardstick is the written checklist, not generated recommendations.

## Findings

| # | Pri | Where | Steps | Saw | Expected | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Projects home, phone (390) | Menu > Projects | Header was two rows: the logo alone (the name "OverCut" is hidden under 720 px by a rule meant for the editor bar), then "Import file…" and "New project" below it | Name and both actions on one row; the home screen is the first thing a phone user sees | Fixed: the hide rule is scoped to `.topbar`; under 520 px "Import file…" is icon-only (still named, title kept); under 360 px the name hides again. Smoke in `project-library.spec.ts` |
| 2 | P1 | Menu on phone (390) | Open the "…" menu | Command row, then System / Dark / Light / High contrast with no heading, then two status lines: four unlabeled groups; the first section was unreadable as a set | A "Theme" heading above the three theme rows | Fixed (`App.tsx`, reuses `theme.label`) |
| 3 | P1 | Media bin, desktop (1440) | Import a clip | Meta line cut to "320×180 · 1 …": the size was lost. The tag button is invisible until hover but kept a 32 px slot in the card | The size always fits (the codec may be cut) | Fixed: on a mouse the tag button overlays the card on hover/focus and takes no space. Smoke in `media-bin.spec.ts` (text column >= 120 px) |
| 4 | P2 | Projects home, "New project" twice | Round 9 open item | Header button always; the empty state repeats it as a call to action. The "tile" of round 9 no longer exists (`projects-new-tile` count 0 is asserted) | A decision | Decision: keep both. The header button is the always-reachable accent action (as `button-chrome.spec.ts` says); the empty state's button is the call to action and is never shown next to a list. No test change |
| 5 | P2 | Shortcuts dialog, desktop | `?` | "Change" buttons are 44 px tall with a mouse, rows 48 px: heavy next to the 36 px controls elsewhere | 36 px on a mouse | Not changed: `shortcuts.spec.ts` asserts 44 px on purpose. Owner call if it should follow `--target` |
| 6 | P2 | Details panel, desktop | Import a 160x120 clip | "Canvas 4:3 · 160 × 120 · 30 fps": "fps" wraps to a second line | One line (smaller value or wrap at a separator) | Not mine (inspector lane); reported |
| 7 | P2 | Projects home, phone | Two or more projects | One 16:9 poster per row (about 200 px tall each): two projects fill the screen | A compact row card (poster left) shows 4 to 5 projects | Not done: layout change of the card, needs its own PR (issue below) |

## Works, keep it
- Token system: spacing 4-based, radius 4/8/12/16, type 11-22 with three weights, elevation 1-3, motion tokens zeroed under reduced motion; dark, light and high-contrast pairs are checked by `theme-contrast.test.ts`. Nothing inconsistent found worth re-theming.
- Icons: one outline stroke (1.7) and a filled transport set, one `Icon` component; no emoji.
- Palette and shortcuts at 390 and 1440: rows 44 px on touch, key hints on desktop only, no overflow.
- Error screen: calm copy, work-saved line, Reload and copy report; privacy and network dialogs read well in light.
- Offline media card (red edge, "Choose file") is clear.

## Not verified
- Real-device touch; screen reader pass; a project list with 50+ cards on a phone.
- Light theme of every dialog at 320 px (Home, Menu and project menu were checked).
- Token changes: none made.
