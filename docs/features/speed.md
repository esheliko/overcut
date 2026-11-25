# Clip speed (M2-008, M2-026)

A clip plays its source at a constant speed from 0.25x to 4x. Preview, timeline length and export all follow, and the sound keeps its pitch.
Freeze frame and reverse are stretch goals (see the end); this page covers constant speed only.

## Behaviour
- The user selects a clip and picks a preset (0.5, 1, 1.5, 2) or types a value (0.25 to 4). The inspector's Speed section says "Keep pitch".
- The clip keeps its **start** and its **source window**. Its timeline length becomes `source length / speed`: 2x halves it, 0.5x doubles it.
- **Default: no overlap.** Slowing a clip so that it would run into the next clip on its track is refused whole (`Overlap`), and the UI says
  so. With **ripple** (the user's choice) the clips that start at or after the old end shift by the change on the clip's own track.
- Linked clips (video + its audio) change together: the editing layer sends one list of `set_clip_speed` ops for the pair, one undo step.
- Speed is not animated (no keyframes) and is the same for the whole clip. To change speed mid-clip, split first.

## Data model
`Clip.speed` already exists (`Rational`, positive, 1/1 by default, schema v4): source length = `duration * speed`. No schema bump.

New ops (wire: `packages/engine-client/schema/edit-contract.json`):
- `set_clip_speed { clip, speed, ripple? }`: compound; expands to one `set_clip` (plus `set_clip` shifts when `ripple`). Atomic, one undo step.
- `set_clip` gains optional `speed` (absent = unchanged). The inverse of `set_clip_speed` uses it, so undo restores speed and geometry exactly.

Errors: `BadSpeed` (outside `1/4..=4`, zero, negative), `Overlap`, `EmptyClip` (nothing left), `BeyondMedia` (cannot happen when slowing:
the window only shrinks), `TrackLocked`.

## Exact integer maths
- A clip must read a whole number of source ticks (`duration * num` divisible by `den`; the speed is reduced `num/den`). So the new length
  is a multiple of `den`: `steps = floor(source_len / num)`, `new_len = steps * den`, reading `steps * num <= source_len` source ticks.
  At most `num - 1` source ticks (under a microsecond for the speeds the UI offers) are dropped at the clip's end. Nothing else is rounded.
- Source time at timeline time `t` = `source_in + floor((t - start) * num / den)` (`evaluate`, unchanged): monotonic, integer.
- Frames shown while slowed repeat source frames (no blending in M2); sped-up playback skips source frames.

## Playback and export (M2-026)
- `evaluate` already reports `speed` on each audio segment and the source time of each video layer; the decode scheduler asks the source
  for those times, never for `t - start + source_in`.
- Audio is time-stretched (pitch preserved) by a WSOLA time-scale modifier written in `crates/audio/src/stretch.rs` (own code, no
  third-party DSP, so no licence to check against ADR 0004). A clip's whole source window is stretched once to its timeline length
  (`ClipStretchCache` in `engine-client`, a few clips kept, clips over 5 minutes fall back to plain resampling and shift pitch) and the
  mixers read it like speed-1 audio: `evaluate` gives each audio segment `clip_source_in`, `clip_source_len` and `clip_offset` for this.
  Preview and export call the same function, so what you hear is what you export.
- The stretcher runs in the wasm module on every host, the desktop webview included (as the compositor already does): PCM never crosses
  IPC, so there is no Tauri command for it.
- Algorithm: 25 ms Hann frames; slower than 1x the frames are placed 12.5 ms apart in the output, faster they are read 12.5 ms apart (so
  the windows tile the input and a click never lands on a window edge); each frame slides up to +-10 ms to the position that best matches
  the natural continuation of the previous one (coarse then fine search), overlapping windows are summed and divided by their sum.
- Export uses the same evaluation per frame and the same stretcher, so the exported length equals the sequence length and A/V stay in sync.
- Tests: stretcher output length and pitch (unit); 0.5x and 2x sync on `crates/media/tests/fixtures/flash_click.mp4`; export a 2x clip and
  check duration and sync with ffprobe.

## UI
- Inspector "Speed" section (`apps/web/src/inspector/`): four preset buttons + a number field + "Keep pitch" note, 44 px targets, in the
  phone sheet like the other sections. A refusal shows the engine's reason in plain words.
- Timeline: a speed badge ("2x") on clips whose speed is not 1 (`apps/web/src/timeline/`, lane C).

## Edge cases
- Image clips have no source length; speed is hidden for them. Audio-only and video clips both take speed.
- Speed on a clip with transform keyframes: key times are clip-relative timeline times, so they keep their timeline position; keys past the
  new end are simply unused.
- Old files: every clip already carries `speed: 1/1`; nothing to migrate.

## Test plan
Engine: exact length and source window at several speeds, ripple on/off, overlap refusal, bad speeds, undo restores byte for byte,
proptest (read never exceeds the old window, source mapping monotonic, undo exact), the op in the S7 generator and the wire contract,
`npm run test:e2`. Playback/export and UI tests as listed above; smoke step for the inspector section.

## Stretch (only after constant speed ships)
Freeze frame (hold one source frame for N ticks) and reverse (negative direction; needs a decode scheduler that reads backwards).
Not part of this slice's contract: the wire has no field for them yet.
