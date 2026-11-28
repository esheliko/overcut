# UX round 16, lane B: Details, export, saving and the project name

Evidence: `audit/desk`, `audit/phone`, `audit/first` reports of the round-16 journey simulation. Behaviour: `docs/features/export-dialog.md` ("M2 UX r16"), `docs/features/clip-transform.md` ("Details tabs follow the clip"), `docs/features/persistence.md` ("Save now and the project name").

## What changed (finding, before, after)

| ID | Before | After |
| --- | --- | --- |
| DESK-2, PHONE-4 | Export said nothing about black stretches; a 4 s hole or music longer than the picture exported as black. | The settings view shows "Your video has 2 gaps (18 s) that will be black" (`pictureGaps`), a "Show first gap" button (closes the dialog and puts the playhead on the gap) and the main button reads "Export anyway". Testids `export-warning`, `export-show-gap`. Smoke step. |
| FIRST-6 | Export was offered and ran on a project with an unreadable clip, then failed at the end; the error card kept about 300 px of empty height. | Preflight: "1 clip needs its file again" + "Reconnect files" (the app's own Allow access / Choose files again), Export disabled with the reason printed above it (`export-offline`, `export-why`). A failure shrinks the dialog to its words (desktop). Smoke step. |
| DESK-3, FIRST-4 | A sound showed "Video \| Speed", the Speed tab stayed from the last clip; a photo showed Video \| Speed with "stills have no speed". | `detailsModel.ts`: picture Video \| Speed, photo Photo \| Duration, sound Audio \| Speed; each new kind of selection opens on its own first tab. Photo Duration is a number of seconds (whole frames, one `trim_out`, arrows nudge, Shift x10, Alt x0.1, a -/+ pair of half seconds). The Audio tab renders the `AudioControls` slot for lane D. |
| DESK-6 | Chip "2 clips + linked audio", Details "4 clips selected". | One formatter (`selectionText` + `selectionCount`) used by the toolbar chip and the Details header; a linked picture and sound are one clip. |
| DESK-13, FIRST-13 | "Playhead is off this clip" was a 34 px row at the top that pushed Transform down; two cramped lines on a photo with a 12 px button; the active diamond turned white on hover. | The note is a one-line sticky overlay at the panel's bottom edge (never between controls; 48 px on touch); the active diamond keeps the accent colour in every state. The Keep-pitch help line (which promised a switch that does not exist) now reads "The sound keeps its natural pitch at any speed." |
| DESK-14 | Menu had only "Save project as..."; Ctrl+S did nothing visible; the chip did nothing. | "Save" menu row, Ctrl/Cmd+S and a click on the chip: flush to storage (`whenDurable` + `checkpoint`), chip says "Saved just now" for 2.5 s. |
| PHONE-6 | The project name was written only on blur; Enter/Go and a reload lost it. | Written on input (400 ms pause), on Enter / Go (`enterKeyHint="done"`) and on blur. Smoke step (reload after Enter, reload after typing). |
| DESK-16, FIRST-14, PHONE-16 | Dialog height 745/640/680 and top edge 32/80/60 px between settings, progress and done; done poster was the black playhead frame; the ETA went 2 min, 41 s, 46 s; "You can keep watching" next to "Keep this screen open"; "MP4 (H.264) with Opus sound"; done buttons below the fold on a phone. | One top edge and height for settings, progress and done. The done poster is the first non-black frame of the finished file at 50%, 33%, 66%, 20%, 80%. `stepEta`: moving average of the rate, the figure can only count down. One note: "Editing is paused until it finishes. Keep this screen open." Plain format words (below). Done has a sticky footer (Save, Share, Export again, Close). |
| DESK-17 | Details ended mid-row with no sign there was more. | A 40 px bottom fade over the Details body while it is clipped (`useScrollCue` sets `data-more`; no layout space of its own). |

### How the engine picks AAC or Opus (asked in the brief)
`engine-client/src/export/presets.ts` tries MP4 + H.264 + AAC first. Only when the device has no AAC encoder (typical for Linux Chromium builds, including the headless test browser) does it fall back to MP4 + H.264 + Opus and attach a warning. So the r15 note holds: AAC is preferred. The dialog now says plainly "MP4 · works in most apps and phones" for AAC and "MP4 · the sound may not play in some apps" for Opus-in-MP4 (the longer note under it explains where). On the desktop app the native encoder always writes AAC.

## Cost
No hot-path work added. The gap list is computed only while the dialog is open (cached per scene). `useScrollCue` does one `requestAnimationFrame` check per scroll/resize/DOM change of the Details body. The ETA is O(1) per progress update. The done-poster search draws up to 5 small canvases once per finished export.

## Not done (and why)
- A picture while exporting (the running view still shows the film placeholder when the playhead frame is black): the engine does not hand out frames during an encode and a mid-project frame would need a second decode; the aspect-ratio frame and the percent carry it.
- "Show first gap" does not select the gap (there is no gap selection in the timeline yet); it moves the playhead. Lane A can listen for a gap request if it adds one.
- The "Advanced" row's explanatory sentence (FIRST-14) is untouched.
- Keyframe diamond colour in light and high-contrast themes was checked by token (`--accent` on `--accent-soft`), not by screenshot.
- Ripple on a photo's Duration: it trims the clip's end only (later clips stay put; "no room" is explained). Lane A owns the ripple default.

## Notes for the other lanes
- **Lane D (volume and fade):** fill `apps/web/src/inspector/AudioControls.tsx` (`{ clips }`: the selected sounds). It renders under the "Audio clip" card of the Audio tab (single sound and a selection of sounds); nothing else in Details needs to change. A new `Section` from `Inspector.tsx` can be exported for reuse.
- **Lane A:** `Speed.tsx` is untouched except through the i18n text of `speed.pitch`; the toolbar chip now calls `selectionText` from `inspector/detailsModel.ts` (one-line change in `Timeline.tsx`).
- The save chip (`data-testid="save-state"`) stays a status `<span>` (so no second "Save" button for `getByRole`); a click on it saves, `data-just` is set during "Saved just now".
- Stale test updated: `tests/unit/export-dialog.test.ts` pinned the old format labels ("MP4 (H.264), works in most apps and devices" and so on); the labels changed on purpose (plain words), the "never says everywhere" assertion stays.

## Screenshots (after; the before states are in the audit shots)
`img/r16-b-export-gap-{desk,phone}.png` (gap warning, "Export anyway"), `img/r16-b-export-offline-{desk,phone}.png` (blocked Export with its reason), `img/r16-b-export-done-phone.png` (sticky Save / Export again / Close), `img/r16-b-details-audio-desk.png` (Audio | Speed on a sound), `img/r16-b-details-photo-{desk,phone}.png` (Photo | Duration). The done poster in these shots is black because the headless fixture's frames are black; the search for a non-black frame is exercised only on real footage.
