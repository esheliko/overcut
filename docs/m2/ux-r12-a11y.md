# M2 UX round 12, lane "a11y" (WCAG 2.2 AA sweep)

Method: `npm run build` + `vite preview`, Playwright (Chromium) with `@axe-core/playwright` (wcag2a, wcag2aa, wcag21a/aa, wcag22aa) on every surface of the editor in dark, light and high-contrast at 390x844 touch and 1440x900 mouse; plus scripts for what axe cannot judge: a Tab walk of every surface (focus ring width and 3:1 contrast, focus hidden under a sticky bar or sheet, target sizes), a mouse-free edit journey, focus after every dialog close, per-element contrast of every text node and every icon/field boundary (own computation, because axe marks text inside `<dialog>` as "incomplete"), reflow at 320x640 and 320x256 (400 % zoom), WCAG text-spacing overrides. Fixtures: `crates/media/tests/fixtures`. No screen reader and no real device were available here.

`tests/smoke/a11y.spec.ts` keeps the axe part in CI: 6 runs (3 themes x 2 sizes), 14 surfaces each (empty editor, media sheet, editor with a selected clip, Details / Edit sheet, clip context menu, timeline More menu, app menu, command palette, shortcuts, privacy / network log, versions, canvas dialog, export dialog, Projects home, project menu, error screen), zero serious or critical violations. No rule is disabled. Two scans exclude the timeline toolbar while a popover is open on top of it (axe's `target-size` counts a covered button as undersized); the toolbar is scanned without a popover on the other surfaces. The timeline canvas is a `<canvas>`, so axe cannot read inside it: it is a named `slider` described by `#tl-summary` with a screen-reader clip list (`tl-clip-list`); the colours painted on it are chosen by `inkOn()` (black or white, whichever is >= 4.5:1) and the strips are the accent / audio strip tokens.

Dev dependency: `@axe-core/playwright` 4.14 (MPL-2.0, file-level copyleft, we modify none of its files) pulls `axe-core` (MPL-2.0). Dev-only: it is never in the app bundle or a release, so the GPL-3.0 apps and the `docs/adr/0009-license.md` position are unchanged (same reasoning as Mediabunny in `docs/adr/0004-media-io.md`).

## Findings

| # | Pri | Where | Steps | Saw | Expected | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Splitter (preview / timeline), all themes | axe | `role="separator"` focusable with no `aria-valuenow` while at the default size (critical, `aria-required-attr`); at 256 px window height the value was also above `aria-valuemax` | Value always present and inside min..max | Fixed: measured row height, clamped |
| 2 | P1 | App menu, desktop | axe | Accent colour picker was a `radiogroup` inside `role="menu"` (critical, `aria-required-children`) | Only menu items and groups inside a menu | Fixed: `group` of `menuitemradio` (appearance smoke updated: it looked for `radio`) |
| 3 | P1 | Timeline menus on a phone (clip menu, More) | axe | The sheet's close button was a plain button inside `role="menu"` (critical) | Valid menu children | Fixed: `role="menuitem"` |
| 4 | P1 | Projects home | axe | Card button named "Open {name}" while the visible text is name + facts + edited (serious, 2.5.3 Label in Name; a voice-control user saying the visible words failed) | Accessible name contains the visible text | Fixed: visible text names it, a hidden "Open project:" prefix keeps the verb |
| 5 | P1 | Timeline toolbar (Delete, Ripple delete, Redo, Undo at the end), field Reset | Focus a button, Enter | The action turned the button off and focus fell to `<body>`: a keyboard / screen-reader user restarts from the top (2.4.3) | Focus goes on | Fixed: `a11y/keepFocus.ts`, timeline toolbar hands over to the canvas, elsewhere the next control of the same group; only within 1 s of a key or click and only when focus is on `<body>`. Smoke in `dialog-focus.spec.ts` |
| 6 | P1 | Export dialog on a phone | Tab to "Advanced" | The sticky footer (Export) covered the focused summary (2.4.11 Focus Not Obscured) | Focus scrolls clear of the sticky bar | Fixed: `scroll-padding` on the dialog, the Edit sheet and `.panel-body` |
| 7 | P1 | Phone, tool sheet open | Tab from the sheet into the timeline | Focus went to timeline controls drawn UNDER the sheet, invisible (2.4.11) | Focus is never on something nobody can see | Fixed: when focus moves to a control the sheet covers, the sheet closes |
| 8 | P1 | App menu | Open with Enter, Tab | Tab walked into the page behind the popover (focus on a covered rail button) | Tab leaves the menu like Esc | Fixed: Tab closes the menu and puts focus on its button |
| 9 | P1 | Marker flag | Drag is the only way to move a marker | 2.5.7 Dragging Movements: no single-pointer alternative (delete and re-add loses name and colour) | A non-drag way | Fixed: marker menu "Move to playhead" (one undo step, says when the marker is already there or another one is). Smoke in `markers.spec.ts` |
| 10 | P1 | Failures of Open / Save / Restore | Open a file that is not a project | The message disappeared after 2.5 to 4 s (2.2.1) | Errors persist; info 3-5 s | Fixed by the phone lane in parallel (#245: `failure-note`, persistent with Dismiss, `toastDuration` 3-5 s); this branch dropped its own duplicate on merge |
| 11 | P2 | Timeline canvas, keyboard focus | Tab to it | Focus frame 1 px at 50 % opacity: below the 2 px / 3:1 bar | Same 2 px ring as everywhere | Fixed: `inset 0 0 0 var(--focus-ring-width) var(--focus-ring)` |
| 12 | P2 | Project name field | Tab to it | Only a 1 px border colour change on focus | 2 px ring | Fixed: `:focus-visible` outline in the ring token |
| 13 | P2 | Media search | Focus | Used `--accent`, not the focus token (high contrast: cyan instead of the 3 px white ring) | Token | Fixed |
| 14 | P2 | Splitter, mouse | Measure | 12 px hit area (2.5.8 asks 24 px; 44 px on touch was already so) | 24 px | Fixed: 24 px, same visual position |
| 15 | P2 | Phone Edit sheet | axe target-size | The 40 px sheet handle overlapped the top half of the mini transport Play button (a tap there grabbed the handle) | Play fully hittable | Fixed: the mini-transport row sits above the handle, only its buttons take the pointer (handle stays 40 px) |
| 16 | P2 | Timeline canvas | Screen reader | Announced as "Playhead position" | Says what it is | Fixed: "Timeline, playhead position" (`aria-describedby` summary and clip list unchanged) |
| 17 | P2 | `theme-contrast` unit test | Review | Focus ring was checked on bg / surface / surface-2 only | surface-3 too (menus, hovered rows) | Fixed: pair added, passes in 3 themes x 7 accents |
| 18 | P2 | Project name field at rest | Look | A transparent field with no boundary: not identifiable as editable (1.4.11) until hover or focus | A visible cue | Not changed (look decision, a persistent border or underline changes the top bar): issue #242 |
| 19 | P2 | Failed project open | Open junk | Toast ends with raw parser text ("invalid Zip archive: Could not find EOCD") | Plain reason | Not changed (copy and engine messages, not a11y): issue #242 |

## 2.5.7 Dragging Movements: every drag and its non-drag alternative

| Drag | Alternative |
|---|---|
| Move a clip (and across tracks) | `Comma` / `Period` nudge, `Mod+Alt+Left/Right` hop over a neighbour, `Alt+Up/Down` change lane (registry, palette) |
| Trim a clip edge | `[` `]` trim to playhead, `Alt(+Shift)+Comma/Period` by a frame |
| Slip / slide / roll / ripple trim | `Mod+Comma/Period`, `Mod+Shift+...`, `Mod+Alt+...`; the tool picker |
| Marker flag | Marker menu "Move to playhead" (new, #9) |
| Track reorder | Track menu "Move up / down" |
| Picture handles on the preview (move, scale, rotate) | Position / scale / rotation fields in Details (keyboard, number entry) |
| Splitter, sheet handle, Overview, zoom | Arrow keys / Home / End on each (all `role` with value) |
| Playhead scrub | Arrow keys on the timeline, Next / Previous frame buttons |
| Media from the bin to the timeline | "Add to timeline" button on each card, palette "Add media at playhead" |
| In / out range | `I` / `O` at the playhead, More menu |
| Keyframes | Key buttons beside every field in Details (no drag) |

## Works, keep it

- Zero serious / critical axe violations on every surface in all three themes after the fixes; text contrast measured per element (own script, all text nodes, ancestors' opacity composited): nothing below 4.5:1 (3:1 for large text) on the editor, Details / Edit sheet, app menu, shortcuts, privacy, versions, canvas, export and Projects home, dark / light / high-contrast, phone and desktop. Field borders and icon-only glyphs are >= 3:1 (only the project name field fails, #18).
- Focus ring: 2 px (3 px in high contrast), >= 3:1 on every control that a Tab walk of every surface reaches; nothing hidden under a sticky bar or the sheet after #6 and #7.
- Targets: >= 44 px on touch everywhere >= 24 px with a mouse everywhere (only the splitter was 12).
- Dialog focus: Esc and the dialog's own button both return focus to the invoker (shortcuts, privacy, versions, palette, canvas, export, new-project confirm), desktop and phone.
- Keyboard-only edit journey (import by file input stand-in, Tab to timeline, `Enter` picks, `Alt+Right` playhead, `S` split, `]` trim, `Alt+Down` lane, nudge, undo, `Shift+F10` clip menu, Details fields and key buttons, palette, Export dialog): every step works and says what it did in the polite live region.
- Live regions: toast and save state are `role="status"`; export progress, completion and failure go through the announcer (failure assertive); errors in dialogs are `role="alert"`.
- Reflow: no horizontal scroll on any surface at 320x640 (touch), 320x256 (400 % zoom), with the WCAG text-spacing overrides at 390 and 1440.
- Reduced motion: tokens zero the durations and a global rule disables animation and transition.
- Perf (container, calibrated estimate; `node tests/perf/edit-latency.mjs`, 2300-clip sample, median of 15, two runs each): base `m2` 1x split commit 2.8 / 3.0 ms, key to paint 13.1 / 13.4 ms; this branch 3.0 / 2.5 ms and 13.4 / 12.8 ms. 4x CPU throttle: base 11.8 / 11.1 ms commit, 39.4 / 37.4 ms key to paint; this branch 12.0 / 10.9 ms and 38.5 / 35.6 ms. No regression (the focus keeper does nothing unless a focused button was just turned off).

## Not verified

- A screen reader (NVDA, VoiceOver, TalkBack): roles, names and live regions are from the DOM and axe only; the focus keeper in particular should be heard once.
- Real touch devices and the installed PWA; Windows forced-colors mode (the high-contrast theme is the app's own).
- JS-driven motion (zoom and scroll easing on the canvas) under reduced motion: not measured.
- Contrast of canvas-painted clip colours is by construction (`inkOn`, strip tokens), not asserted per theme.
- Desktop (Tauri) shell.
