# M2 UX round 12, lane "phone" (first-time user on a phone, the first two minutes on any device)

Method: `npm run build` + `vite preview`, Playwright with Chromium (named devices iPhone SE, iPhone 13, Pixel 7, iPad Mini, plus 320x640 and iPhone 13 landscape; dark and light), real fixtures from `crates/media/tests/fixtures`. Scripts drive only visible, labelled controls and count taps; every step checks horizontal overflow, console errors/warnings and touch targets under 44 px. All timings are **container, calibrated estimate** (a Linux container, Chromium with `Emulation.setCPUThrottlingRate` 4x as the phone proxy), not a real device. The skill's checklist (`pro-rules.md`, `quick-reference.md`) was the yardstick: pointer-feedback, 44 px targets, Back/dismissal behaviour, focus not lost, content jumping, toast timing (3-5 s, errors persist), empty states with one action, reduced motion through the motion tokens.

## Journeys (taps and seconds)

Taps are real touches (`tap()`), seconds are scripted wall time after the engine is ready, not human time. Budgets: `docs/ACTIVATION-TEST.md` (import, trim, export in under 90 s for a person; the scripted proxy is at most 9 taps on a phone).

| # | Journey | Device | Taps | Scripted | Verdict |
|---|---|---|---|---|---|
| 1 | First open to first export of a trimmed clip (Import, ruler, Split, select first part, Delete, Export, Export, Save) | iPhone SE, iPhone 13, Pixel 7, iPad Mini | 8, 8, 8, 8 | 3.8 s, 4.1 s, 3.7 s, 4.0 s | Within budget (9). No dead end. The preview's own Import button is one tap; opening the Media tab first is 9 (the activation spec). |
| 2 | 3-clip vertical video with a cut and a speed change (Canvas, 9:16, Apply, import 3 files at once, ruler, Split, select, Edit, Speed tab, value, Export x2, Save) | iPhone 13 | 13 to 14 (counted from the steps; the script ran to the Edit sheet: 8 taps, 2.2 s) | not run to the end | One picker for all three files and the clips land in order: good. The 9:16 shape is a native `<select>` (2 taps). Nothing to fix. |
| 3 | PiP: import A, Media, import B (stays in the bin, the sheet closes), More, "Add as overlay on a new track" | iPhone 13 | 5 to the overlay (about 8 with placing and sizing, counted from the steps) | 3.2 s to the overlay | Works. "Add as overlay" is only in the timeline's More menu and the palette: the Media card's "+" adds on the same track. Issue below. |
| 4 | Reopen yesterday's project: Projects, tap the card, Choose files, Export, Export, Save (from the Home list; 7 from inside the editor: Menu, Projects first) | iPhone 13, Pixel 7 | 5 (7) | 3.2 s, 3.2 s | Fine now that the missing-media note exists (#3 below). Without it a reloaded project showed a black preview and no explanation. |
| 5 | Recover from a missing media file | iPhone 13 | 2 (Choose files, pick) | 0.4 s from the note to reconnected | Was the weakest journey: no message at all on the editor surface unless the project came from a file. Fixed (#3). |

## Findings

| # | Pri | Where | Steps | Saw | Expected | Status |
|---|---|---|---|---|---|---|
| 1 | P1 | Projects home, phone | 3 projects at 390x844 | One 16:9 poster card per row, 270-289 px each: two projects fill the screen (round 11 shell #7, open) | A compact row (poster left) so 4 to 6 fit; 50 projects scroll smoothly | Fixed: under 600 px each project is a 76 px row, poster 112 px on the left, "…" menu centred on the right; 5 projects fit one 390x844 screen. 50 projects, 4x CPU, scroll p50 and p95 16.7 ms, 0 frames over 33 ms. Smoke `phone-r12.spec.ts` |
| 2 | P1 | Phone, any sheet or dialog | Open Media (or a dialog), press Back / swipe back | The page left the editor (there is no history entry for a sheet or dialog); the open sheet and unsaved context were gone | Back closes the top sheet or dialog first | Fixed: `layout/backStack.ts` pushes one history entry per open layer (same URL), Back closes the top layer, closing by X/Esc/backdrop takes the entry off again. Used by the Media/Edit sheet, every `Modal` (canvas, rename, delete, privacy, versions, shortcuts, tags), the Export dialog (running export goes to the background, as with its X) and the command palette. Unit test for the stack, smoke for the sheet and a dialog |
| 3 | P1 | Editor, project whose media is not on this device | Import a clip, reload | Black preview, faded clips, no message; the "N files are not on this device" note only showed after opening a `.overcut` file | The editor says what is wrong and offers the one fix, whenever media is missing | Fixed: the slim note "1 file is missing." with "Choose files…" and a close shows whenever the open project has offline media (dismissed once per project open). Copy: "Locate files…" became "Choose files…". Smoke after a plain reload |
| 4 | P1 | Failures (cannot open/save a file, restore fails, list fails) | Open a file that is not a project | The message was a toast that left after 4 s: gone before it was read | Errors persist until resolved | Fixed: `fail()` now raises a `role="alert"` note (`failure-note`) with a close button; successes keep the toast. `project-lifecycle.spec.ts` asserted the old 4 s toast: updated to the new note (the old expectation was the bug) |
| 5 | P1 | Media sheet, phone | Tap outside the sheet | Nothing: the only ways out were the X and the handle | Backdrop tap closes the sheet; the top bar (Export) and tool bar stay usable | Fixed: `.sheet-scrim` above the picture and timeline, below the sheet; not for the Edit sheet (its peek keeps the picture and the handles live). Landscape: the backdrop reaches the bottom and leaves the rail. `activation.spec.ts` tapped the preview's Import button behind the sheet; on a phone it now taps the sheet's own Import (same tap count, 9) |
| 6 | P1 | Sheet and dialogs with the on-screen keyboard | Focus the Media search, a rename field or a size field | The fixed bottom sheet stays at the layout bottom, under the keyboard | The field being typed in stays visible | Fixed: `useKeyboardInset` publishes `--kb` and `--vvh` from the visual viewport; the sheet sits above the keyboard and caps its height, `.pj-dialog` lifts by half of it. Verified with a stand-in visual viewport (headless has no keyboard); not on a real device |
| 7 | P2 | Sheet handle | Audit all phones | The handle (a drag target) was 40 px tall | 44 px | Fixed (44 px) |
| 8 | P2 | Focus after closing | Close the Media sheet or the Rename / Delete dialog opened from a card's "…" menu | Focus fell to the page (the opener was hidden or gone) | Focus returns to the control that opened it | Fixed: the sheet returns focus to its tool button; Home returns it to the card's "…" |
| 9 | P2 | Toasts | Any info toast | 2.5 to 4 s | 3 to 5 s | Fixed (3 s, longer text up to 5 s); `new-project-confirm.test.ts` expected 2500: updated (the checklist range replaced the old guess) |
| 10 | P2 | Empty timeline, empty Media sheet, touch | Open the app on a phone | "Drop or import media…" and "Drop files here, or tap…": nothing can be dropped on a phone; at 320 px the hint wrapped to three lines and ran over the lane edge | Words that fit the device | Fixed: touch gets "Import media to start. Export turns on once there is a clip." and "Videos, photos and audio. Tap to choose from this device." (pointer: coarse) |
| 11 | P2 | Tool picker (Select, Ripple, Roll, Slip, Slide) | Timeline toolbar, "Select" | Five editing words with no explanation for someone who has never met them | A plain line under each | Fixed: one-line hints ("Trim a clip and pull the clips after it along", "Move the cut between two clips", "Change which part of the clip shows, same length", …). Shared menu item got an optional `sub` |
| 12 | P2 | Posters | Poster arrives after the card | Appeared at once | Fade in over the placeholder, no size change | Done for the Media card and the Projects poster (`scrim-in`, motion token). Slots were already fixed-size: CLS 0 |

## Measured (container, calibrated estimate)

| What | Result |
|---|---|
| Startup, 4x CPU, iPhone 13, cold | tap-ready editor 1.33 s, FCP 0.47 s, CLS 0 |
| Startup, 4x CPU, warm (5 runs) | 0.62 to 0.79 s, FCP 0.29 to 0.40 s, CLS 0 |
| Startup, no throttle (before my changes) | engine ready 0.44 to 0.63 s on SE / 13 / 320 px. The shell skeleton (`.boot`) is already in `index.html`: nothing blank, nothing to add |
| Projects home, 3 projects, 4x CPU, reload to first card | 0.7 s to 1.2 s, CLS 0 |
| Import a second clip in the Media sheet, CLS | 0 |
| Projects scroll, 50 cards, 4x CPU | p50 16.7 ms, p95 16.7 ms, 0 frames over 33 ms. `content-visibility:auto` was tried and removed: no gain, one 83 ms hitch and a scrollbar that drifts while it learns card heights |
| Offline reload (service worker) | the app loads in 0.17 s with the network off; calm: there is nothing to say because nothing needs the network |

`tests/perf/timeline-bench.mjs` and `edit-latency.mjs` were not run: no timeline or preview code changed (the one Timeline.tsx change is two strings and a menu hint).

## Works, keep it
- First journey: 8 taps, no dead end; the Media sheet closes by itself after an import, the clip lands on the timeline, selecting the first part picks picture and sound, one Delete cuts both.
- Multi-file import in one pick; clips land in order; a second import stays in the bin (does not disturb the timeline).
- Detents, flick-to-close and arrow keys of the sheet handle; Edit sheet's mini transport.
- Safe-area insets are applied on the editor, the sheet, the toast and the notes in portrait and landscape; 0 px horizontal overflow on SE, 13, Pixel 7, iPad Mini, 320 px and landscape; no console errors or warnings in any run; no touch target under 44 px after the handle fix.
- Offline-first: reload with no network works and says nothing.

## Not verified
- A real on-screen keyboard (the stand-in visual viewport proves the maths and the CSS, not the browser's behaviour); real notches (headless has no `env(safe-area-inset-*)`); real thumb reach; screen reader pass on the new notes.
- 50 projects with real posters (the 50-project run had 7 real posters, the rest placeholders).
- Light theme of every dialog at 320 px (Home and the notes were checked).

## Issues filed (label `m2-ux`)
- "Add as overlay" is only in the timeline's More menu and the palette; a first-time PiP user looks in the Media sheet. Suggested: a second action on the Media card (or a "+" menu with "Add as overlay").
- Edit sheet at its small size covers the whole timeline lane area on a 390x664 viewport (the toolbar stays); worth testing whether the peek should be shorter, or the lane shown above it. Ergonomics lane.
- The preview is black for a clip whose file is missing, with no words on the picture (the note below the tracks explains). Preview lane: "Media missing" on the frame.

## Screenshots (`docs/features/img/m2-r12/phone/`, 390x844 and 1440x900, scale 1)
- Projects home, phone: `home-phone-before.png` (poster cards, two projects fill the screen) and `home-phone-after.png` (compact rows, five projects); desktop `home-desktop-after.png` (unchanged poster grid).
- Missing media: `offline-phone-before.png` (nothing said) and `offline-phone-after.png` (the slim note above the tool bar).
- Media sheet: `sheet-phone-before.png` and `sheet-phone-after.png` (backdrop).
- Tool picker: `tools-phone-before.png`, `tools-phone-after.png`, `tools-desktop-before.png`, `tools-desktop-after.png` (plain-language lines).
