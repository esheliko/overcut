# UX r14, lane C: Details, media bin, export

Owner ask: changing a clip should feel direct and visual, like CapCut's right-hand panel; the bin and the export dialog should look like part of the same editor. Screenshots (dark, desktop 1440x900 and phone 390x844): `docs/m2/img/r14-c-*.png`.

## What changed (before -> after)

### Details (`inspector/*`)
- **Before**: a flat list of number rows, `Crop & flip` behind a native `<details>`, one global Reset, Speed on a separate tab. **After**: sections with sticky headers and a chevron: **Transform** (position X/Y, scale, rotation), **Opacity**, **Crop & flip** (crop edges, fit, flip; closed by default) and **Speed** (embedded; the Speed tab stays). Which sections are open is remembered while the selection changes.
- Each value is a **slider plus the scrubbable number** (label and number drag as before; Shift x10, Alt x0.1, Esc cancels) with its unit; the keyframe diamond, previous/next key and easing picker are unchanged. The slider covers the everyday range (position +-100 %, scale 1-400 %, rotation +-180 deg, opacity 0-100 %, crop 0-95 %); the number still takes the whole engine range, with the existing range note.
- **One undo per gesture**: a slider drag (pointer down to up) or a key press shares one coalescing key, so 40 pointer moves are one undo step (the same `newGestureKey` as the number field). The preview follows live through the same store path as before.
- **Per-section reset** (an arrow in the header, hidden-when-default), next to the existing per-value reset and the global Reset.
- **States**: nothing selected shows the project summary (canvas, background, length, clips); several clips shows "N clips selected" with what to do; an audio clip says it has no picture to move. A still has no Speed section.
- **Touch**: on `pointer: coarse` each value is one 44 px row (label | slider | number | diamond), so a whole section fits the short phone sheet. With a mouse the slider sits under the number (rows about 64 px instead of 96).

### Media bin (`media/*`)
- **Grid / list toggle** (grid is the default; the choice is remembered in `localStorage`, failing soft). Grid cards have a 16:9 poster, the duration badge on it, the name and meta under it, and the add / overlay / tags buttons over the poster's corner.
- **On timeline** is a pill with words and, when a picture is used more than once, a count ("On the timeline x2"). A video's own linked sound is not counted as a second use.
- Press feedback (scale 0.985 within 100 ms) on cards and the toggle; `content-visibility: auto` on grid cards so a long bin stays cheap.
- The empty drop zone is bigger and lists the formats it takes (MP4, MOV, WebM, MP3, WAV, JPG, PNG).
- **Left out: hover-scrub of the poster.** The bin only holds one poster per media; scrubbing needs a decoded frame per pointer move (a worker round-trip per move, or a stored filmstrip per media), which is not cheap. Not done rather than done badly.

### Export (`export/*`)
- **Merged presets**: presets that would write the same file for this project (same size, rate, format, quality, no different cap) are one tile; the tile names the others ("Also gives the same file as YouTube 1080p, Facebook"). A remembered merged preset selects its tile. Pure function `mergePresets` in `export/model.ts`, unit tested (`tests/unit/export-merge.test.ts`).
- **Preview frame** at the output's real shape (a 9:16 preset is tall, with the picture inside it as the export will place it), next to a large "About 6.87 MB", the length and the output size and rate. The picture is a one-time copy of the preview canvas when the dialog opens (nothing is decoded; if the preview has nothing, an icon shows).
- Progress and done views show the same frame (dimmed while running, with a check badge when done). The primary Export button was already sticky; it is now asserted in the smoke test to be fully on screen.

## Tests changed on purpose
- `export-dialog.spec.ts`: the preset tile count is 6, not 8, for the 160x120 fixture (YouTube and Facebook merge into Original); the Facebook step now asserts it is merged and named on the Original tile.
- `media-bin.spec.ts`: the file now opens the bin in list view (`localStorage`) because its geometry checks (card height, meta on one line, "Import and Filter share one row") describe the list. The new grid has its own steps.
- New: `tests/smoke/ux-r14-c.spec.ts` (sections, slider drag = one undo, per-section reset, collapse; grid/list and the pill; export frame, merged tile, Export in view) and `tests/unit/export-merge.test.ts`.

## Measured cost
- JS/CSS: Inspector +~3 KB, bin +~1 KB, export CSS in the lazy dialog chunk. No new dependency, no new per-frame work: the slider reuses the number field's store path; sections that are closed are not rendered.
- The export preview is one `drawImage` of the preview canvas at dialog open (<= 480 px wide, JPEG 0.72); no decode.
- Not measured on the 1000-clip bench: no timeline or playback code was touched.
