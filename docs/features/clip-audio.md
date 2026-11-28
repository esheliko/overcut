# Clip volume and fades (AU-01, M2 round 16)

A clip's own loudness: a volume from 0% to 200%, a fade in and a fade out. Preview and export play exactly the same level.
Keyframed gain and pan stay in M3 (`docs/FEATURES.md`, AU-01); this page covers the static part that was pulled into M2 because, in the round-16
journey tests, the very next step after "add music" was "make it quieter" and there was no way to do it.

## Behaviour
- **Volume**: linear gain `0..=2`, shown as 0-200%. 100% (the default) plays the clip as recorded. 0% is silence ("Mute clip").
- **Fade in / fade out**: seconds, each from 0 to half the clip (so the two never overlap), set in steps of 10 ms. The fade is a **linear ramp of the
  level**: 0 to 1 over the fade-in from the clip's first sample, 1 to 0 over the fade-out ending at its last sample. The volume multiplies it.
  (A single clip fades to silence, so equal-power is not needed; it matters for crossfades between two clips, which are not in M2.)
- **Where**: Details, Audio tab (a sound clip, or a picture with sound: the edit lands on its linked sound). Volume and each fade have a slider and a
  number; double-click on a field puts it back (100% / 0 s); typing past the limit says so. **Mute clip** sets volume 0 and remembers the old level
  for this session; **Unmute clip** puts it back. The same toggle is in the clip's right-click menu.
- **On the timeline** (audio clips only): a clip that was changed shows its **volume line** at the real level (100% in the middle, 200% at the top,
  silence at the bottom) and its fade ramps. A selected clip always shows the line, plus a white **dot at each top corner** (the fade handles).
  Drag the line up or down to change the volume (it clicks onto 100%); drag a dot sideways to change that fade. The number shows while dragging.
  One drag is one undo step. Only a selected clip has a line to grab, so grabbing the clip anywhere else still moves it.
- A trim after the fades were set may leave them longer than the clip: playback shortens both in proportion; the Details fields keep what was set.
- Split: the left piece keeps the fade in, the right piece the fade out, both keep the volume. Undo of the split restores the original.

## Data model
`Clip.audio: ClipAudio { volume: f32 = 1, fade_in: Time = 0, fade_out: Time = 0 }`, not written while it is the default. Schema 5 -> 6 (`v5_to_v6`,
only the version changes: older files open with plain clips; older apps must not open a file that has it). `volume` must be finite in `0..=2`, fades
`>= 0` (checked by `Project::validate`, by `InsertClip` and by the op below; `BadAudio`).

Op: `set_clip_audio { clip, audio }`. Replaces the three values. Inverse: the old value. A slider drag, a typing session or a line/handle drag shares one
coalescing key, so it is one undo step. A fade longer than the clip is accepted (a trim can cause it, and an undo must always be able to restore it).

## Engine
`evaluate` puts on every `AudioSegment`: `gain` (the volume), `fade_in`, `fade_out` (samples at the sequence rate, already shortened to fit) and
`clip_len` (samples in the whole clip). `AudioSegment::gain_at(i)` is the one definition of the level of sample `i`; the TypeScript twin is
`segmentGain` in `packages/engine-client/src/audio-gain.ts`. A clip at volume 0 yields no segment (nothing is decoded for it).
The envelope depends on the sample's place in the clip (`clip_offset + i`), so cutting the audio into windows differently gives the same result
(`the_envelope_is_the_same_however_the_audio_is_cut_into_windows`).

Both mixers call `segmentGain` per sample: `apps/web/src/preview/audioMix.ts` (`mixSegment`, `mixStretched`) and `packages/engine-client/src/export/audio-mix.ts`
(`AudioMixer`). `tests/unit/audio-gain.test.ts` checks the TypeScript values against the engine's and that preview and export give identical samples.
No new Tauri command or wasm binding is needed: ops and the evaluated description are JSON the existing bindings already carry.

## Edge cases
- Volume above 100% can clip: the export clamps to [-1, 1] and the preview limiter rounds off what goes over (as for any loud mix).
- A muted track (header switch) stays silent whatever the clips' volume; clip volume and track mute are independent.
- A clip narrower than 40 px shows no line, narrower than 80 px no handles (use the Details fields).
- Touch: the line has a 28 px band, the dots a 44 px target; a press on them only becomes a change after the finger moves 8 px.
- Read-only projects and locked tracks: no handles, the fields are disabled.

## Test plan
- Rust: model (defaults not written, range checks, v5 and v6 fixtures), `SetClipAudio` (undo, one step per drag, refusals, split), `evaluate` (volume, ramps, windows, shortening), property test step.
- TypeScript: `tests/unit/audio-gain.test.ts` (parity), `tests/unit/clip-audio.test.ts` (model, hit, drag, ops), clip menu.
- Smoke: `tests/smoke/clip-audio.spec.ts` (Details volume and fade, line drag, mute, export level).
