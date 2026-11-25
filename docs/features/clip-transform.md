# Clip transform (M2-003, TL-13, TL-14)

**Behaviour.** Every clip has a `transform`: position, scale, rotation, anchor, crop, flip, opacity and fit. The default is the identity and is not written to the file, so M1 projects open and save unchanged (schema v2 -> v3, `crates/model/fixtures/project.v3.json`).

**Data** (`crates/model/src/transform.rs`). All numbers are `Animated` (ADR 0015), so keyframes (M2-004) need no format change.
- `position_x/y`: offset of the anchor from the canvas centre, in canvas widths / heights (resolution independent). 0 = centred.
- `scale_x/y`: 1 = the size `fit` gives; must be > 0 (mirroring is `flip_h/v`).
- `rotation`: degrees clockwise about the anchor.
- `anchor_x/y`: pivot as an offset from the picture centre, in picture widths / heights.
- `crop_left/top/right/bottom`: fraction of the source removed per edge, `0 <= v < 1`, opposite edges sum to < 1.
- `opacity`: `0..=1`. `fit`: `contain` (M1 look), `cover`, `stretch`.

**Edit.** `Op::SetClipTransform { clip, transform }` replaces the whole transform; the inverse is the old one. A drag sends many under one `History` key (one undo step). Invalid values: `OpError::BadTransform`, project unchanged. Not allowed on a locked track.

**Evaluate.** `VideoLayer.props` carries the values at the frame (clip-relative time, clamped so bezier overshoot cannot leave the valid range) and `opacity` equals `props.opacity`. `VideoLayer.transform` is still the unmodified canvas-centre placement. The compositor (M2-024) builds the matrix from `props` and the media size.

**Edge cases.** Split: the left half keeps the transform; the right half gets values continued at the cut with later keys re-based (a bezier segment cut in two is approximated by the same easing over the shorter span). Trimming the head does not move keys (ADR 0015). Opacity 0 still produces a layer (the compositor may skip it).

**Tests.** Unit and property tests in `app-model::transform`; `SetClipTransform` in the S7 generator (valid and invalid values: apply then inverse restores, errors change nothing); v3 fixture migration; wire example in `edit-contract.json` (Rust and TS); ABI 2 -> 3 (`VideoLayer` gained `props`).
