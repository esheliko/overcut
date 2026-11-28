# M2 UX round 13, lane B: #246 and #241

Worker B. Base `m2`. Screenshots: `docs/features/img/m2-r13/b/` (before / after, phone 390x844 and desktop 1440x900, scale 1).

| Issue | Before | After |
|---|---|---|
| #246 "Add as overlay" hidden | Only More > "Add as overlay on a new track" and the palette; the Media card had just "+" (same track). Phone: import B, then 5 taps once known | The Media card of a clip not yet on the timeline has an **Add as overlay** button (picture-in-picture icon) beside Tags and "+": one tap on a phone (2 with opening the Media sheet). Mouse: shown on hover/focus like Tags. Same code path as the More item (`addMediaItem`). More and the palette are unchanged |
| #241 speed | Details > Speed tab > preset: 2 clicks | `T` = 2x, `Shift+T` = 0.5x, `clip.speedNormal` (no default key). 1 key. Preset tooltips show the key |
| #241 opacity keyframe | Click the field, type, click the diamond | `Shift+D` adds (or removes) an opacity keyframe at the playhead, holding the current value (type a value with the field as before). 1 key. Diamond tooltip shows the key; announced ("Opacity keyframe added at ...") |
| #241 export | Two clicks | `Ctrl/Cmd+E` opens the Export dialog (the Start press is still the dialog's own). The button tooltip shows the key |

## Time on task (round-12 scripted pro run, affected steps; measured by `tests/smoke/r13-keys-overlay.spec.ts`)
Before: 14 keys + 1 click for the six steps that had keys, plus 2 clicks (speed), 3 actions (keyframe), 2 clicks (export) = 14 keys + 8 pointer actions. After: 14 keys + 1 click + 3 keys (T, Shift+D, Ctrl+E) = **17 keys + 1 click, no pointer needed**. Overlay on a phone: 5 taps -> 2 (Media, overlay button).

## Decisions and notes
- Default keys avoid browser chords (a unit test lists them) and every existing binding (`findConflicts` stays empty, also for the presets). `K` is the player's pause key and the preview panel swallows `Shift+J/K/L` with its own hard-coded handler (`PreviewPanel.tsx`, not touched: lane A's file), hence `Shift+D` and not `Shift+K` for the keyframe.
- `Shift+D` / `T` are plain-letter global keys like `S`, `M`: they do nothing while typing in a field.
- The overlay button is hidden for media already on the timeline: the card is two lines at 390 px and a third 44 px control wrapped the name (the existing `media-bin` size assertions guard that). Owner may prefer a "+" menu instead; say so and it is a small change.
- On desktop the two hover buttons (overlay, Tags) cover the end of the name and meta line while hovering a narrow card (same as Tags before).
- `Timeline.tsx` got three command cases (no hot path). `tests/perf/edit-latency.mjs`, container, before -> after: 1x split commit 2.7 -> 2.9 ms, key->paint 12.8 -> 12.7, undo 13.3 -> 12.0, redo 13.6 -> 14.1; 4x split 11.7 -> 11.6, key->paint 37.1 -> 42.5, undo 35.7 -> 37.4, redo 34.5 -> 36.1 (run-to-run noise in this container; nothing on the edit path changed).
