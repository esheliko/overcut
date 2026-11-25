//! Clip transform, crop, flip and opacity (M2-003, TL-13/TL-14, `docs/features/clip-transform.md`).
//!
//! Every number is an [`Animated`] (ADR 0015) so keyframing it later (M2-004) needs no format change. The identity transform is the
//! default and is not written, so M1 files open and save unchanged. Units do not depend on the output size, so a project keeps its
//! look when the canvas changes: positions are fractions of the canvas, crops fractions of the source picture.

use crate::anim::{AnimError, Animated};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How the picture is first sized into the canvas, before scale applies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Fit {
    /// Whole picture visible, bars where the shapes differ (the M1 behaviour).
    #[default]
    Contain,
    /// Picture covers the canvas, the overflow is cut off.
    Cover,
    /// Picture is stretched to the canvas shape.
    Stretch,
}

fn zero() -> Animated {
    Animated::constant(0.0)
}
fn one() -> Animated {
    Animated::constant(1.0)
}

/// Position, scale, rotation, anchor, crop, flip, opacity and fit of one clip. `Default` is the identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClipTransform {
    /// Offset of the anchor from the canvas centre, in canvas widths (+ right). 0 = centred.
    #[serde(default = "zero")]
    pub position_x: Animated,
    /// Offset in canvas heights (+ down).
    #[serde(default = "zero")]
    pub position_y: Animated,
    /// 1 = the size `fit` gives. Must be > 0 (flip is separate).
    #[serde(default = "one")]
    pub scale_x: Animated,
    #[serde(default = "one")]
    pub scale_y: Animated,
    /// Degrees clockwise around the anchor.
    #[serde(default = "zero")]
    pub rotation: Animated,
    /// The point rotation, scale and flip pivot on, as an offset from the picture centre in picture widths / heights.
    #[serde(default = "zero")]
    pub anchor_x: Animated,
    #[serde(default = "zero")]
    pub anchor_y: Animated,
    /// Fraction of the source picture removed from each edge, `0..1`; `left + right < 1` and `top + bottom < 1`.
    #[serde(default = "zero")]
    pub crop_left: Animated,
    #[serde(default = "zero")]
    pub crop_top: Animated,
    #[serde(default = "zero")]
    pub crop_right: Animated,
    #[serde(default = "zero")]
    pub crop_bottom: Animated,
    /// `0..=1`.
    #[serde(default = "one")]
    pub opacity: Animated,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default)]
    pub fit: Fit,
}

impl Default for ClipTransform {
    fn default() -> Self {
        ClipTransform {
            position_x: zero(),
            position_y: zero(),
            scale_x: one(),
            scale_y: one(),
            rotation: zero(),
            anchor_x: zero(),
            anchor_y: zero(),
            crop_left: zero(),
            crop_top: zero(),
            crop_right: zero(),
            crop_bottom: zero(),
            opacity: one(),
            flip_h: false,
            flip_v: false,
            fit: Fit::Contain,
        }
    }
}

/// What a transform is not allowed to hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransformError {
    /// A value or key is NaN/infinite, or keys are unordered (see [`AnimError`]).
    Anim(AnimError),
    /// A value is outside its range (scale <= 0, opacity or a crop outside `0..=1`, crops that leave nothing).
    OutOfRange,
}

impl ClipTransform {
    pub fn is_identity(&self) -> bool {
        *self == ClipTransform::default()
    }

    fn props(&self) -> [&Animated; 12] {
        [
            &self.position_x,
            &self.position_y,
            &self.scale_x,
            &self.scale_y,
            &self.rotation,
            &self.anchor_x,
            &self.anchor_y,
            &self.crop_left,
            &self.crop_top,
            &self.crop_right,
            &self.crop_bottom,
            &self.opacity,
        ]
    }

    /// The transform of the right-hand clip when a clip is cut `rel` ticks after its start: values continue, keys after the cut move
    /// to the new clip's time, and the segment crossing the cut starts from the value there (a partial bezier segment is approximated
    /// by the same easing over the shorter span). The left-hand clip keeps its transform as is (later keys are harmless, never reached).
    pub fn split_right(&self, rel: crate::Time) -> ClipTransform {
        use crate::anim::Keyframe;
        let cut = |a: &Animated| {
            if a.keys.is_empty() {
                return a.clone();
            }
            let v = a.eval(rel);
            let easing = a
                .keys
                .iter()
                .rev()
                .find(|k| k.t <= rel)
                .map(|k| k.easing)
                .unwrap_or(crate::Easing::Linear);
            let mut keys: Vec<Keyframe> = Vec::new();
            if !a.keys.iter().any(|k| k.t == rel) {
                keys.push(Keyframe {
                    t: crate::Time::from_ticks(0),
                    v,
                    easing,
                });
            }
            keys.extend(a.keys.iter().filter(|k| k.t >= rel).map(|k| Keyframe {
                t: crate::Time::from_ticks(k.t.ticks() - rel.ticks()),
                ..*k
            }));
            Animated { value: v, keys }
        };
        ClipTransform {
            position_x: cut(&self.position_x),
            position_y: cut(&self.position_y),
            scale_x: cut(&self.scale_x),
            scale_y: cut(&self.scale_y),
            rotation: cut(&self.rotation),
            anchor_x: cut(&self.anchor_x),
            anchor_y: cut(&self.anchor_y),
            crop_left: cut(&self.crop_left),
            crop_top: cut(&self.crop_top),
            crop_right: cut(&self.crop_right),
            crop_bottom: cut(&self.crop_bottom),
            opacity: cut(&self.opacity),
            ..self.clone()
        }
    }

    /// Ranges are checked on the static value and on every key (between keys values are interpolated, so a bezier overshoot can
    /// leave the range: consumers clamp the evaluated value with [`ClipTransform::at`]).
    pub fn validate(&self) -> Result<(), TransformError> {
        for a in self.props() {
            a.validate().map_err(TransformError::Anim)?;
        }
        let all =
            |a: &Animated, ok: &dyn Fn(f64) -> bool| ok(a.value) && a.keys.iter().all(|k| ok(k.v));
        let unit = |v: f64| (0.0..=1.0).contains(&v);
        let ok = all(&self.scale_x, &|v| v > 0.0)
            && all(&self.scale_y, &|v| v > 0.0)
            && all(&self.opacity, &unit)
            && [
                &self.crop_left,
                &self.crop_top,
                &self.crop_right,
                &self.crop_bottom,
            ]
            .iter()
            .all(|a| all(a, &|v| (0.0..1.0).contains(&v)));
        if !ok {
            return Err(TransformError::OutOfRange);
        }
        // A pair of crops must leave something at every key time and for the static values.
        let mut times: Vec<_> = [
            &self.crop_left,
            &self.crop_right,
            &self.crop_top,
            &self.crop_bottom,
        ]
        .iter()
        .flat_map(|a| a.keys.iter().map(|k| k.t))
        .collect();
        times.sort();
        times.dedup();
        let t0 = crate::Time::from_ticks(0);
        for t in std::iter::once(t0).chain(times) {
            let e = |a: &Animated| a.eval(t);
            if e(&self.crop_left) + e(&self.crop_right) >= 1.0
                || e(&self.crop_top) + e(&self.crop_bottom) >= 1.0
            {
                return Err(TransformError::OutOfRange);
            }
        }
        Ok(())
    }

    /// The values at clip-relative `t`, clamped into range (bezier overshoot cannot make a layer invalid).
    pub fn at(&self, t: crate::Time) -> TransformValues {
        let f = |a: &Animated| a.eval(t);
        let crop = |a: &Animated| f(a).clamp(0.0, 0.99);
        let mut crop4 = [
            crop(&self.crop_left),
            crop(&self.crop_top),
            crop(&self.crop_right),
            crop(&self.crop_bottom),
        ];
        // Overshoot could make the pairs cross; shrink the pair proportionally so a sliver always remains.
        for (a, b) in [(0, 2), (1, 3)] {
            let s = crop4[a] + crop4[b];
            if s > 0.99 {
                let k = 0.99 / s;
                crop4[a] *= k;
                crop4[b] *= k;
            }
        }
        TransformValues {
            position: [f(&self.position_x) as f32, f(&self.position_y) as f32],
            scale: [
                f(&self.scale_x).max(1e-6) as f32,
                f(&self.scale_y).max(1e-6) as f32,
            ],
            rotation: f(&self.rotation) as f32,
            anchor: [f(&self.anchor_x) as f32, f(&self.anchor_y) as f32],
            crop: crop4.map(|v| v as f32),
            opacity: f(&self.opacity).clamp(0.0, 1.0) as f32,
            flip: [self.flip_h, self.flip_v],
            fit: self.fit,
        }
    }
}

/// A [`ClipTransform`] evaluated at one time: what the compositor needs (M2-024). Units as in `ClipTransform`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct TransformValues {
    pub position: [f32; 2],
    pub scale: [f32; 2],
    /// Degrees clockwise.
    pub rotation: f32,
    pub anchor: [f32; 2],
    /// Left, top, right, bottom.
    pub crop: [f32; 4],
    pub opacity: f32,
    pub flip: [bool; 2],
    pub fit: Fit,
}

impl Default for TransformValues {
    fn default() -> Self {
        ClipTransform::default().at(crate::Time::from_ticks(0))
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::anim::{Easing, Keyframe};
    use crate::Time;

    #[test]
    fn identity_is_default_and_valid() {
        let t = ClipTransform::default();
        assert!(t.is_identity());
        assert_eq!(t.validate(), Ok(()));
        let v = t.at(Time::from_ticks(0));
        assert_eq!(v.scale, [1.0, 1.0]);
        assert_eq!(v.opacity, 1.0);
        assert_eq!(v.crop, [0.0; 4]);
    }

    #[test]
    fn empty_object_reads_as_identity_and_round_trips() {
        let t: ClipTransform = serde_json::from_str("{}").unwrap();
        assert!(t.is_identity());
        let mut t2 = ClipTransform::default();
        t2.rotation = Animated::constant(33.5);
        t2.flip_h = true;
        t2.fit = Fit::Cover;
        let s = serde_json::to_string(&t2).unwrap();
        assert_eq!(serde_json::from_str::<ClipTransform>(&s).unwrap(), t2);
    }

    #[test]
    fn split_right_continues_the_animation() {
        let mut t = ClipTransform::default();
        t.rotation = Animated {
            value: 0.0,
            keys: vec![
                Keyframe {
                    t: Time::from_ticks(0),
                    v: 0.0,
                    easing: Easing::Linear,
                },
                Keyframe {
                    t: Time::from_ticks(1000),
                    v: 100.0,
                    easing: Easing::Linear,
                },
            ],
        };
        let r = t.split_right(Time::from_ticks(250));
        assert_eq!(r.validate(), Ok(()));
        for i in [0, 100, 750] {
            assert_eq!(
                r.rotation.eval(Time::from_ticks(i)),
                t.rotation.eval(Time::from_ticks(250 + i))
            );
        }
        assert!(ClipTransform::default()
            .split_right(Time::from_ticks(5))
            .is_identity());
    }

    #[test]
    fn rejects_bad_ranges() {
        let bad = |f: &dyn Fn(&mut ClipTransform)| {
            let mut t = ClipTransform::default();
            f(&mut t);
            assert_eq!(t.validate(), Err(TransformError::OutOfRange));
        };
        bad(&|t| t.scale_x = Animated::constant(0.0));
        bad(&|t| t.opacity = Animated::constant(1.5));
        bad(&|t| t.crop_left = Animated::constant(1.0));
        bad(&|t| {
            t.crop_left = Animated::constant(0.5);
            t.crop_right = Animated::constant(0.5)
        });
        let mut t = ClipTransform::default();
        t.position_x = Animated::constant(f64::NAN);
        assert!(matches!(t.validate(), Err(TransformError::Anim(_))));
    }

    #[test]
    fn evaluated_values_are_clamped_after_overshoot() {
        let mut t = ClipTransform::default();
        t.opacity = Animated {
            value: 0.5,
            keys: vec![
                Keyframe {
                    t: Time::from_ticks(0),
                    v: 0.0,
                    easing: Easing::Bezier {
                        x1: 0.0,
                        y1: 3.0,
                        x2: 1.0,
                        y2: 3.0,
                    },
                },
                Keyframe {
                    t: Time::from_ticks(1000),
                    v: 1.0,
                    easing: Easing::Linear,
                },
            ],
        };
        for i in 0..=100 {
            let o = t.at(Time::from_ticks(i * 10)).opacity;
            assert!((0.0..=1.0).contains(&o));
        }
    }
}
