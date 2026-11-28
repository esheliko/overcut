# UX round 15, lane B: media, import, preview, phone and tablet shell

Evidence: the round-15 journey audit (DESK-n, PHONE-n, FIRST-n, CUST-n). Feature rules updated: `docs/features/media-bin.md`, `editor-layouts.md`, `design-system.md`.

## What changed (before -> after)
| Finding | Before | After |
|---|---|---|
| FIRST-3, PHONE-3 | first import placed, later single imports bin-only silently, phone sheet closed into nothing | one rule: bin always; timeline too when it is empty or the drop was on it; else toast "Added to Media . Add to timeline"; phone sheet closes only when the result is on the timeline |
| DESK-5, PHONE-4 | Overlay silently inserted the newest media | Overlay opens a thumbnail picker of the bin (`OverlayPicker`) |
| FIRST-6, PHONE-2 | 310 px / 6-line error wall over the timeline | two lines + Details; phone notice two lines, auto-leaves, above the tool strip; chips come from one list (`media/formats.ts`), MP3/WAV removed, M4A added |
| CUST-1 | after reload every file "File not found" + "N files are missing" | "Needs permission to open" + ONE "Allow access" that asks every kept handle inside the click; only truly unreadable files say missing |
| PHONE-5 | sheet peek 45 % hid the timeline; edited clip not under the playhead | peek 30 % (ruler and playhead visible), opening Edit/Speed/Crop moves the playhead onto the clip |
| PHONE-6 | Delete off-screen, Back a full slot | Back, Split, Delete, Speed, Edit, Crop...; Back is a 44 px chevron |
| PHONE-8 | system Back left the app from a selected clip and from Projects | Back: deselect, close sheet, Projects to editor |
| PHONE-9 | Speed highlighted Edit; Edit opened the last tab | Edit opens Video; the pressed button is the one that opened the sheet |
| PHONE-10 | 4 taps through native selects | ratio tiles row in the canvas dialog, one tap applies |
| PHONE-14, DESK-17 | overscroll/selection/double-tap defaults, 1 px page scroll, SVG-only icon | `overscroll-behavior: none`, `touch-action: manipulation`, no chrome selection, no page scroll (measured 0), apple-touch-icon + PNG/maskable icons |
| PHONE-21, DESK-15 | tap did nothing; accent outline looked like selection | tap selects (accent outline = selected); list rows keep the pill short |
| FIRST-4, FIRST-21 | portrait tablet: drop zone cut, toolbar clipped, status chip cut | compact drop-zone row, toolbar loses its slider and scrolls inside itself, status chip hidden at 900-1099 px |
| FIRST-8, PHONE-11, DESK-21 | "Preparing smooth scrubbing 0%" chip on the picture | quiet ring in the player bar after 0.9 s and above 0 % |
| DESK-8 | fullscreen kept the handles and the chip | both hidden |
| DESK-19 | toast on the picture | toast measured to sit just above the timeline (above the sheet on a phone) |

Cost: no engine or hot-path change; one extra IndexedDB read per offline media on open; entry JS unchanged within noise. Screenshots: `SCRATCH/r15/b/{before,after}-*.png` (after at 2x).

## Not done
- DESK-9 (preview lags the gizmo ~280 ms after release): only seen under software GL; no safe cheap fix without worker changes, needs a GPU measurement first.
- PHONE-12, PHONE-16 (landscape docking, merged transport row, "Drop" copy lives in `timeline/draw.ts`, lane A).
- PHONE-9 second half (Crop opens "Crop & flip" expanded, remove duplicate Speed section): `inspector/*` is lane C.
- CUST-1 cannot be exercised in headless Chromium (no real file handles); covered by reasoning and the card/note states only.
- WAV/MP3 chips: join `IMPORT_FORMATS` when lane C's import lands. `media-bin.spec.ts` feeds a fake `clip.wav` and expects "Can't read clip.wav. It may be damaged"; keep it valid when WAV import ships.
