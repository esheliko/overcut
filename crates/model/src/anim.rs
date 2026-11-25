//! Animatable values: a static value plus optional keyframes (ADR 0015, spike S9 / M2-001).
//!
//! A keyframed property is `Animated { value, keys }`. With no keys it is the plain `value` (so a property can be added
//! to a clip as `#[serde(default)]` and old files open unchanged); with keys it is evaluated at a clip-relative time.
//! Keys are clip-relative ticks (they move with the clip, trimming the head does not shift them), strictly
//! ascending, identified by their time (no ids). The easing of a key shapes the segment that *leaves* it.

use crate::curve::{cubic_bezier, lerp};
use crate::time::Time;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Easing {
    /// Keeps this key's value until the next key (a step).
    Hold,
    Linear,
    /// CSS-style `cubic-bezier`; `x1` and `x2` must be in `[0,1]`.
    Bezier {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    },
}

impl Easing {
    /// CSS presets, stored as their numbers (the file has no preset names; the UI matches them back for display).
    pub const EASE: Easing = Easing::Bezier {
        x1: 0.25,
        y1: 0.1,
        x2: 0.25,
        y2: 1.0,
    };
    pub const EASE_IN: Easing = Easing::Bezier {
        x1: 0.42,
        y1: 0.0,
        x2: 1.0,
        y2: 1.0,
    };
    pub const EASE_OUT: Easing = Easing::Bezier {
        x1: 0.0,
        y1: 0.0,
        x2: 0.58,
        y2: 1.0,
    };
    pub const EASE_IN_OUT: Easing = Easing::Bezier {
        x1: 0.42,
        y1: 0.0,
        x2: 0.58,
        y2: 1.0,
    };

    /// Eased progress for `x` in `[0,1]` (`Hold` is handled by the caller: it never blends).
    pub fn apply(self, x: f64) -> f64 {
        match self {
            Easing::Hold => 0.0,
            Easing::Linear => x,
            Easing::Bezier { x1, y1, x2, y2 } => cubic_bezier(x1, y1, x2, y2, x),
        }
    }

    fn valid(self) -> bool {
        match self {
            Easing::Hold | Easing::Linear => true,
            Easing::Bezier { x1, y1, x2, y2 } => {
                (0.0..=1.0).contains(&x1)
                    && (0.0..=1.0).contains(&x2)
                    && y1.is_finite()
                    && y2.is_finite()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Keyframe {
    /// Clip-relative time (0 = the clip's first tick on the timeline).
    pub t: Time,
    pub v: f64,
    /// Shape of the segment from this key to the next (ignored on the last key).
    #[serde(default = "linear")]
    pub easing: Easing,
}

fn linear() -> Easing {
    Easing::Linear
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnimError {
    /// A value or control point is NaN or infinite, or a bezier `x` is outside `[0,1]`.
    NotFinite,
    /// Keys are not strictly ascending by time.
    Unordered,
    /// `move_key` target time already holds another key.
    Occupied,
    /// No key at that time.
    NoKey,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Animated {
    /// The value when there are no keys.
    pub value: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<Keyframe>,
}

impl Animated {
    pub fn constant(value: f64) -> Animated {
        Animated {
            value,
            keys: Vec::new(),
        }
    }

    pub fn is_animated(&self) -> bool {
        !self.keys.is_empty()
    }

    /// Checks what ops promise (documents loaded from disk are checked with this before use).
    pub fn validate(&self) -> Result<(), AnimError> {
        if !self.value.is_finite() {
            return Err(AnimError::NotFinite);
        }
        for k in &self.keys {
            if !k.v.is_finite() || !k.easing.valid() {
                return Err(AnimError::NotFinite);
            }
        }
        if self.keys.windows(2).any(|w| w[0].t >= w[1].t) {
            return Err(AnimError::Unordered);
        }
        Ok(())
    }

    /// Value at clip-relative `t`: before the first key and after the last the end values hold; between two keys the
    /// first key's easing decides. Allocation-free; two comparisons plus one bisection solve for a bezier segment.
    pub fn eval(&self, t: Time) -> f64 {
        let (first, last) = match (self.keys.first(), self.keys.last()) {
            (Some(f), Some(l)) => (f, l),
            _ => return self.value,
        };
        if t <= first.t {
            return first.v;
        }
        if t >= last.t {
            return last.v;
        }
        // keys[i].t <= t < keys[i+1].t
        let i = self.keys.partition_point(|k| k.t <= t) - 1;
        let (a, b) = (&self.keys[i], &self.keys[i + 1]);
        if a.easing == Easing::Hold {
            return a.v;
        }
        // i64 ticks convert exactly below 2^53 (145 years, ADR 0010); the ratio is one correctly rounded division.
        let x = (t.ticks() - a.t.ticks()) as f64 / (b.t.ticks() - a.t.ticks()) as f64;
        lerp(a.v, b.v, a.easing.apply(x))
    }

    /// Inserts a key, or replaces the key at the same time. Returns the key it replaced (the inverse of this op is
    /// `set_key(old)` if `Some`, else `remove_key(t)`).
    pub fn set_key(&mut self, key: Keyframe) -> Result<Option<Keyframe>, AnimError> {
        if !key.v.is_finite() || !key.easing.valid() {
            return Err(AnimError::NotFinite);
        }
        Ok(match self.keys.binary_search_by(|k| k.t.cmp(&key.t)) {
            Ok(i) => Some(std::mem::replace(&mut self.keys[i], key)),
            Err(i) => {
                self.keys.insert(i, key);
                None
            }
        })
    }

    pub fn remove_key(&mut self, t: Time) -> Result<Keyframe, AnimError> {
        match self.keys.binary_search_by(|k| k.t.cmp(&t)) {
            Ok(i) => Ok(self.keys.remove(i)),
            Err(_) => Err(AnimError::NoKey),
        }
    }
}

/// Deterministic probe: evaluates `n` pseudo-random samples (integer xorshift, so the inputs are identical everywhere)
/// over a mix of hold, linear and bezier segments and folds the result bits into a hash. The same hash on native and
/// WebAssembly is the S9 determinism bar (`docs/adr/0015-keyframes.md`); M2-004 keeps it as a golden.
pub fn golden_checksum(n: u32) -> u64 {
    let mut rng: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    let mut hash: u64 = 0xCBF2_9CE4_8422_2325;
    let mut anim = Animated::constant(0.0);
    let mut produced = 0;
    while produced < n {
        // A fresh random property every 64 samples.
        anim.keys.clear();
        let count = 2 + (next() % 6) as i64;
        let mut t = 0_i64;
        for _ in 0..count {
            t += 1 + (next() % 70_560_000) as i64; // up to 0.1 s, in ticks
            let v = (next() % 2_000_001) as f64 / 1000.0 - 1000.0;
            let easing = match next() % 6 {
                0 => Easing::Hold,
                1 => Easing::Linear,
                2 => Easing::EASE,
                3 => Easing::EASE_IN,
                4 => Easing::EASE_OUT,
                _ => Easing::Bezier {
                    x1: (next() % 1001) as f64 / 1000.0,
                    y1: (next() % 4001) as f64 / 1000.0 - 1.5,
                    x2: (next() % 1001) as f64 / 1000.0,
                    y2: (next() % 4001) as f64 / 1000.0 - 1.5,
                },
            };
            let _ = anim.set_key(Keyframe {
                t: Time::from_ticks(t),
                v,
                easing,
            });
        }
        let end = anim.keys.last().map_or(1, |k| k.t.ticks() + 1);
        for _ in 0..64.min(n - produced) {
            let at = Time::from_ticks((next() % (end as u64 + 1000)) as i64 - 500);
            hash = (hash ^ anim.eval(at).to_bits()).wrapping_mul(0x0000_0100_0000_01B3);
            produced += 1;
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(ticks: i64) -> Time {
        Time::from_ticks(ticks)
    }
    fn key(at: i64, v: f64, easing: Easing) -> Keyframe {
        Keyframe {
            t: t(at),
            v,
            easing,
        }
    }

    #[test]
    fn no_keys_is_the_static_value() {
        assert_eq!(Animated::constant(0.75).eval(t(12345)), 0.75);
    }

    #[test]
    fn linear_hold_and_ends() {
        let mut a = Animated::constant(0.0);
        a.set_key(key(100, 10.0, Easing::Linear)).unwrap();
        a.set_key(key(200, 20.0, Easing::Hold)).unwrap();
        a.set_key(key(300, 40.0, Easing::Linear)).unwrap();
        assert_eq!(a.eval(t(-5)), 10.0, "before the first key");
        assert_eq!(a.eval(t(100)), 10.0);
        assert_eq!(a.eval(t(150)), 15.0);
        assert_eq!(a.eval(t(200)), 20.0);
        assert_eq!(a.eval(t(299)), 20.0, "hold keeps the key's value");
        assert_eq!(a.eval(t(300)), 40.0);
        assert_eq!(a.eval(t(10_000)), 40.0, "after the last key");
    }

    #[test]
    fn bezier_presets_hit_the_ends_and_are_monotonic_for_ease_in_out() {
        for e in [
            Easing::EASE,
            Easing::EASE_IN,
            Easing::EASE_OUT,
            Easing::EASE_IN_OUT,
        ] {
            assert_eq!(e.apply(0.0), 0.0);
            assert_eq!(e.apply(1.0), 1.0);
        }
        let mut prev = 0.0;
        for i in 0..=1000 {
            let y = Easing::EASE_IN_OUT.apply(i as f64 / 1000.0);
            assert!(y >= prev, "ease-in-out must not go backwards");
            prev = y;
        }
        // The symmetric curve passes through (0.5, 0.5).
        assert!((Easing::EASE_IN_OUT.apply(0.5) - 0.5).abs() < 1e-9);
        // A bezier with control points on the diagonal is the identity.
        let diag = Easing::Bezier {
            x1: 0.3,
            y1: 0.3,
            x2: 0.7,
            y2: 0.7,
        };
        assert!((diag.apply(0.123) - 0.123).abs() < 1e-9);
    }

    #[test]
    fn segment_ends_are_exact_values() {
        let mut a = Animated::constant(0.0);
        a.set_key(key(0, 0.1, Easing::EASE)).unwrap();
        a.set_key(key(1_000_000, 0.7, Easing::Linear)).unwrap();
        assert_eq!(a.eval(t(0)), 0.1);
        assert_eq!(a.eval(t(1_000_000)), 0.7);
        assert_eq!(lerp(0.1, 0.7, 1.0), 0.7);
        assert_eq!(lerp(0.1, 0.7, 0.0), 0.1);
    }

    #[test]
    fn set_replaces_and_remove_inverts() {
        let mut a = Animated::constant(1.0);
        assert_eq!(a.set_key(key(50, 2.0, Easing::Linear)), Ok(None));
        let old = a.set_key(key(50, 3.0, Easing::Hold)).unwrap();
        assert_eq!(old, Some(key(50, 2.0, Easing::Linear)));
        assert_eq!(a.keys.len(), 1);
        assert_eq!(a.remove_key(t(50)).unwrap().v, 3.0);
        assert_eq!(a.remove_key(t(50)), Err(AnimError::NoKey));
    }

    #[test]
    fn rejects_non_finite_and_bad_bezier() {
        let mut a = Animated::constant(0.0);
        assert_eq!(
            a.set_key(key(0, f64::NAN, Easing::Linear)),
            Err(AnimError::NotFinite)
        );
        let bad = Easing::Bezier {
            x1: 1.5,
            y1: 0.0,
            x2: 0.5,
            y2: 1.0,
        };
        assert_eq!(a.set_key(key(0, 1.0, bad)), Err(AnimError::NotFinite));
        let unordered = Animated {
            value: 0.0,
            keys: vec![key(5, 0.0, Easing::Linear), key(5, 1.0, Easing::Linear)],
        };
        assert_eq!(unordered.validate(), Err(AnimError::Unordered));
    }

    /// M1 files have no animated properties: a struct that adds one with `#[serde(default)]` reads them unchanged,
    /// and an un-animated property writes back without a `keys` field.
    #[test]
    fn old_files_open_unchanged_and_json_round_trips() {
        #[derive(Serialize, Deserialize, PartialEq, Debug)]
        struct ClipWithProps {
            id: u32,
            #[serde(default = "full")]
            opacity: Animated,
        }
        fn full() -> Animated {
            Animated::constant(1.0)
        }
        let old: ClipWithProps = serde_json::from_str(r#"{"id":7}"#).unwrap();
        assert_eq!(old.opacity, Animated::constant(1.0));
        assert_eq!(
            serde_json::to_string(&old.opacity).unwrap(),
            r#"{"value":1.0}"#
        );

        let mut a = Animated::constant(0.1);
        a.set_key(key(10, 0.1 + 0.2, Easing::EASE)).unwrap();
        a.set_key(key(99, -1e-7, Easing::Hold)).unwrap();
        let back: Animated = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
        assert_eq!(a, back, "f64 values survive JSON bit for bit");
    }

    /// One undo step per drag: 200 `move`s recorded the way `History` does (inverse ops spliced latest-first) restore
    /// the property exactly, whatever the drag passed through.
    #[test]
    fn a_drag_of_200_moves_is_one_inverse_list() {
        let mut a = Animated::constant(0.0);
        for (i, at) in [1000_i64, 2000, 3000].into_iter().enumerate() {
            a.set_key(key(at, i as f64, Easing::Linear)).unwrap();
        }
        let before = a.clone();
        enum Inv {
            Set(Keyframe),
            Remove(Time),
        }
        let mut inverse: Vec<Inv> = Vec::new();
        let mut at = t(2000);
        for step in 1..=200_i64 {
            // move key from `at` to `at + 7 * step % 1900 + 1`, skipping occupied times like the op would reject
            let to = t(1100 + (7 * step) % 1800);
            if a.keys.iter().any(|k| k.t == to) {
                continue;
            }
            let k = a.remove_key(at).unwrap();
            a.set_key(Keyframe { t: to, ..k }).unwrap();
            inverse.splice(0..0, [Inv::Remove(to), Inv::Set(k)]);
            at = to;
        }
        assert_ne!(a, before);
        a.validate().unwrap();
        for inv in inverse {
            match inv {
                Inv::Set(k) => {
                    a.set_key(k).unwrap();
                }
                Inv::Remove(at) => {
                    a.remove_key(at).unwrap();
                }
            }
        }
        assert_eq!(a, before);
    }

    /// S9 bar, native half: the checksum over 1M samples is a constant (the wasm half is
    /// `crates/model/spikes/s9-wasm`, which must print the same value).
    #[test]
    fn golden_checksum_is_stable() {
        assert_eq!(golden_checksum(1_000_000), GOLDEN_1M);
    }
    const GOLDEN_1M: u64 = 8966810943456196906;

    #[test]
    fn evaluates_one_parameter_in_well_under_a_microsecond() {
        // A loose guard (debug build, shared CI): the real figure is measured in release, see the ADR.
        let mut a = Animated::constant(0.0);
        for i in 0..8 {
            a.set_key(key(i * 1000, i as f64, Easing::EASE)).unwrap();
        }
        let start = std::time::Instant::now();
        let mut acc = 0.0;
        for i in 0..100_000 {
            acc += a.eval(t(i % 7000));
        }
        assert!(acc > 0.0);
        assert!(
            start.elapsed().as_micros() < 100_000 * 20 / 1000 * 1000,
            "debug eval slower than 20 us each"
        );
    }
}
