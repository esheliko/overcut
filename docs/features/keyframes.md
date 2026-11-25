# Keyframes (M2-004 engine, M2-048 minimal UI; TL-12)

**Behaviour.** The twelve animatable numbers of a clip's transform (`position_x/y`, `scale_x/y`, `rotation`, `anchor_x/y`, `crop_*`, `opacity`) can carry keyframes. With no keys a property is its static value; with keys it is evaluated at the playhead (clip-relative time). Before the first key and after the last the end values hold. Preview, export and the inspector all read the same evaluation (`ClipTransform::at`, ADR 0015), so an animated clip moves in the export as it does in the preview.

**Data.** ADR 0015 (`crates/model/src/anim.rs`): a key is `{ t, v, easing }`, `t` clip-relative integer ticks (keys move with the clip, trimming the head does not shift them), strictly ascending and unique, addressed by time (no ids). `easing` shapes the segment *leaving* the key: `hold`, `linear` or a CSS `cubic-bezier`. Presets are stored as numbers (ease in `.42,0,1,1`, ease out `0,0,.58,1`, ease in-out `.42,0,.58,1`); the UI names them by matching the numbers. No schema change: keys were already part of `ClipTransform` (schema v3).

**Ops** (`crates/timeline/src/op.rs`, wire examples in `packages/engine-client/schema/edit-contract.json`). `prop` names the property (`TransformProp`).
- `set_keyframe {clip, prop, key}`: add a key or replace the one at that time. Inverse: `set_keyframe` of the replaced key, else `delete_keyframe`.
- `move_keyframe {clip, prop, from, to, value?}`: change a key's time and, if `value` is given, its value. `to` held by another key: `KeyframeOccupied` (the UI nudges by a tick). Inverse: the move back with the old value, so a drag of N moves under one `History` key is one undo step.
- `delete_keyframe {clip, prop, t}`: `NoKeyframe` when absent. Inverse: `set_keyframe` of the key.
- `set_easing {clip, prop, t, easing}`: the segment leaving the key. Inverse: the old easing.
- Common checks (an error changes nothing): clip exists, track unlocked, `t >= 0` (`OutOfRange`), values finite and in the property's range, bezier `x1, x2` in `[0,1]` (`BadTransform`), crop pairs still leave a picture at every key time.
- A property with no keys is edited with `set_clip_transform` as before. Setting a *value* on an animated property from the UI is `set_keyframe` at the playhead (updates the key there or adds one).

**Evaluate.** `VideoLayer.props` already carries the values at the frame; nothing new crosses the wasm/native boundary except the ops (generic `apply`). Cost: 83 ns per parameter with 8 bezier keys (release, `evaluating_a_fully_animated_transform_is_under_a_microsecond_per_parameter`); budget < 1 us.

**Edge cases.** Split re-bases keys onto the right clip (`ClipTransform::split_right`). A key beyond the clip end is kept and harmless. Bezier overshoot is clamped on evaluation (`ClipTransform::at`), keys themselves must be in range. Two keys cannot share a time.

**Tests.** `crates/timeline/src/tests.rs`: S7 property generator has four new kinds (22 total; undo restores exactly, errors change nothing); `keyframe_ops_set_move_delete_ease_and_undo`; `a_keyframe_drag_is_one_undo_step_and_replays_the_same` (200 moves = one undo, journal replay equals); `evaluate_reports_the_animated_values_at_the_frame`; the per-parameter bench; wire contract (29 ops, Rust and TS). Native = wasm values: `golden_checksum` (ADR 0015) covers evaluation; the ops only change the key list.

## Inspector UI (M2-048, minimal)
- Video tab, most-used fields first: position X/Y, scale, rotation, opacity, then a collapsible "Crop & flip" (crop edges, fit, flip), then Reset.
- Each animatable field has a 44 px diamond on its row: outlined = not animated, accent outline = animated but between keys, filled = a key at the playhead (within half a frame). Pressing it adds a key holding the current value, or removes the key; removing a property's last key makes it static at that value (no jump). Disabled while the playhead is off the clip.
- A second line appears once a field is animated: previous / next key buttons (move the playhead to the neighbouring key) and, when the playhead is on a key, the easing picker (Linear, Ease in, Ease out, Ease in-out, Hold; "Custom" is shown for other curves); "Between keyframes" otherwise.
- Editing a field of an animated property sets or updates the key at the playhead (existing easing kept, new keys linear); a handle drag does the same through `useTransformEdit`. A field focus session / drag is one undo step (one coalescing key). Scale keys both axes together.
- `valuesOf(transform, relTicks)` evaluates keys at the playhead (TS port of `Animated::eval` for display; the engine renders the frame).
- Pure helpers: `inspector/keyframeModel.ts` (eval, key state, op builders, `clipKeyTimes` for the timeline's diamonds) and `snapRotation` in `transformModel.ts` (right angles within 3 degrees, Shift = 15 degree steps) for the rotate handle.
- Tests: `tests/unit/keyframe-model.test.ts`, `tests/smoke/inspector.spec.ts` (diamond, easing, edit, remove at desktop and phone).
- Not in this slice: graph editor, custom bezier, copy/paste keys, dragging keys on the timeline.
