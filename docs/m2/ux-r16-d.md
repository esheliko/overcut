# M2 UX round 16, lane D: clip volume and fades (DESK-3, FIRST-4)

After "add music" the next step is "make it quieter", and there was no way to do it. AU-01 (volume, fades, mute) is pulled from M3 into M2
(`docs/FEATURES.md`, `docs/ROADMAP.md`; reason: round-16 journey evidence, add music is the headline first-time task). Keyframed gain and pan stay in M3.
Feature page: `docs/features/clip-audio.md`.

| ID | Before | After |
|---|---|---|
| DESK-3 / FIRST-4 volume | Details for a sound said "a sound has no picture"; no level control anywhere | Details, Audio tab: Volume 0-200% (slider, number, double-click resets), Fade in / Fade out (seconds, up to half the clip). `r16-d-details-desktop.png`, `r16-d-details-phone.png` |
| Timeline | An audio clip showed only its waveform | Changed clips show a volume line at the real level and fade ramps; a selected sound always shows the line plus a white dot at each top corner. Drag the line (clicks onto 100%) or a dot; the value shows while dragging; one undo step. `r16-d-timeline-desktop.png` |
| Mute | none | "Mute clip" / "Unmute clip" in Details and in the clip right-click menu (volume 0, remembers the old level). `r16-d-menu-desktop.png` |
| Picture with sound | n/a | Audio tab edits its linked sound; a sound on its own opens on the Audio tab |
| Model / engine | `gain` was always 1.0 | `Clip.audio {volume, fade_in, fade_out}`, schema 6 (older files open unchanged, plain clips write nothing), op `set_clip_audio`; `evaluate` feeds gain, linear fades, clip length; preview and export share `segmentGain` |

Before screenshots: the audit's Details shot of a sound clip (`scratchpad/audit/*`) shows the old empty card; not recreated.

## Cost
No per-frame allocation in the painter (typed-array reads, one path per layer, one clip rect per audio lane). A clip at volume 0 yields no audio segment, so it is not decoded. Export parity: 50% gives 0.50 of the plain level, the end of a 0.4 s fade is 0.08 (smoke).

## Not done (and why)
- Keyframed gain and pan: M3 by plan.
- Equal-power ramp: a single clip fades to silence, so linear is used; crossfades are not in M2.
- Volume line on a multi-selection: one clip at a time (a group of sounds has no single target in Details).

## Notes for the other lanes
- Lane B had not opened a PR when this was written. The Audio tab is a self-contained component (`apps/web/src/inspector/AudioSection.tsx`) wired in `App.tsx` `Details` (`DetailTab` gained `"audio"`; tabs are `audio, speed` for a sound, `video, audio, speed` for a picture with sound). If lane B owns the tab list, keep `<AudioSection />` as the Audio tab body.
- Shared files touched, small and local: `i18n/en.json` (new `audio.*`, `timeline.say.*`, `timeline.label.*` keys), `Timeline.tsx` (clip menu row, `LABELS`), `clipMenu.ts` (new `mute` row and state fields; the clip-menu unit test list gained `mute`, a deliberate change), `tests/tsconfig.json` (two includes), `layout/toolStrip.ts` (`DetailsRequest.tab` accepts `"audio"`).
- Tests changed because the shape changed: segment literals in `tests/unit/{export,native-export,preview}.test.ts` gained the fade fields; `edit-contract.json`, `patch-contract.json`, the project schema and fixtures were regenerated for schema 6.
