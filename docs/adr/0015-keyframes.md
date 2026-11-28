# 0015 Keyframes and animatable properties
**Status**: accepted (spike S9, M2-001: every success bar met with measured numbers, below)

**Context.** M2 needs transform, opacity and later effect parameters that change over time (TL-12, M2-003/004). Open questions of S9: where keyframes live, which interpolation, which number type, what one undo step is, and whether old files still open.

**Decision.**
1. **Per-property key lists on the clip.** A property is `Animated { value: f64, keys: Vec<Keyframe> }` (`crates/model/src/anim.rs`). No keys = the static `value`. A clip gains properties with `#[serde(default)]` (identity values), so M1 and older files open unchanged and an un-animated property serialises as `{"value": 1.0}` with no `keys` field.
2. **Clip-relative integer ticks** (`Time`, ADR 0010) for key times: keys move with the clip, trimming the head does not shift them, a key is addressed by its time (strictly ascending, unique; no key ids). Moving a key is `remove(t0)` + `set(t1)`; `set_key` returns the key it replaced, which is the inverse.
3. **`f64` values**, finite only (ops reject NaN/inf). JSON round-trips `f64` bit for bit (tested). Consequence for M2-003: `Op`, `Clip` and `Project` must drop the `Eq` derive (keep `PartialEq`); nothing relies on `Eq` for hashing. Fixed-point Q32.32 was the fallback and is not needed.
4. **Interpolation**: `Hold` (step), `Linear`, `Bezier{x1,y1,x2,y2}` (CSS `cubic-bezier`, `x1,x2` in `[0,1]`, `y` free for overshoot). The easing of a key shapes the segment leaving it. CSS presets (`EASE`, `EASE_IN`, `EASE_OUT`, `EASE_IN_OUT`) are stored as their numbers; the UI matches numbers back to names. Before the first key and after the last, the end values hold. Segment end points are exact (`v0*(1-e) + v1*e`).
5. **Deterministic by construction** (`crates/model/src/curve.rs`): only `+ - * /` and comparisons (correctly rounded IEEE-754, no libm, Rust does not fuse multiply-add, WebAssembly has none without relaxed-simd). The bezier x-to-s solve is a safeguarded Newton (bracket plus bisection fallback, stops on `|err| < 1e-15` or bracket < 1e-15, at most 100 steps), a function of the inputs only.
6. **One undo step per drag** uses the existing `History` coalescing key (`docs/features/timeline-ops.md`): M2-004's `SetKeyframe/MoveKeyframe/DeleteKeyframe/SetEasing` carry inverses that are other key ops, spliced latest-first like every other op. Tested at model level: 200 moves of one key with their inverses collected restore the property exactly (`a_drag_of_200_moves_is_one_inverse_list`).

**Measured** (release, workspace profile, Linux container; `cargo run --release -p app-model --example s9_native`, wasm: `node crates/model/spikes/s9-wasm/run.mjs`, Node WebAssembly):
| Bar | Result |
|---|---|
| Same value on wasm and native, 1M random samples | FNV hash of all result bits identical: `8966810943456196906` on both (hold, linear, 3 presets, random beziers, before/after/between keys); kept as the native golden `golden_checksum_is_stable` |
| < 1 us per parameter | linear 8 ns, bezier 100 ns per `eval` with 8 keys (native); wasm 97 ns per sample including key generation |
| Drag of 200 moves = 1 undo entry | model test above; the History key mechanism is already proven by S7 |
| M1 files open unchanged | `old_files_open_unchanged_and_json_round_trips` |

The solve was first a 40-step bisection (777 ns, too close to the bar); safeguarded Newton is 8x faster. A test compares it with a 100-step bisection over a control-point grid: < 1e-9 everywhere except the degenerate curve with a flat inflection (`x1=1, x2=0`), where x(s) is flat at the last bit over about 1e-5 of s, so both methods are as good as `f64` allows (< 5e-6).

**Consequences.** (+) tiny files (no keys, no cost), addressable by time in the UI, cheap eval, identical on all platforms, easy to extend to more easings. (-) `Eq` is lost on the document types; a key addressed by time cannot sit on top of another (the op errors, the UI nudges by one tick); ticks within one clip stay below 2^53 so the progress ratio converts to `f64` exactly (145 years).

**Options not taken.** Key ids (more stable references, but ids in every op and nothing needs them); absolute timeline times (a clip move would rewrite every key); fixed-point values (not needed: determinism holds with `f64`); a separate `animations` table keyed by clip (indirection for no gain).

**Recommendation / follow-ups.** M2-003 adds the clip properties as `Animated` fields with identity defaults and drops `Eq`; M2-004 adds the four ops, evaluation in `evaluate`, the S7 generator cases and the wasm-side golden (via `crates/wasm` tests) for `golden_checksum`.
