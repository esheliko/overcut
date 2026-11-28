//! A clip's own sound: volume and fades (M2 round 16, AU-01, `docs/features/clip-audio.md`).

use crate::time::Time;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Loudest a clip can be set to: 200% (+6 dB).
pub const MAX_VOLUME: f32 = 2.0;

/// Linear gain, fade in and fade out of one clip. `Default` is the plain clip (full level, no fades) and is not written.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClipAudio {
    /// Linear gain, `0..=MAX_VOLUME` (shown as 0-200%). 1 = as recorded; 0 = muted. Not written when 1.
    #[serde(default = "unit", skip_serializing_if = "is_unit")]
    pub volume: f32,
    /// Length of the rise from silence at the clip's start, in ticks (`>= 0`). Not written when 0.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub fade_in: Time,
    /// Length of the fall to silence at the clip's end, in ticks (`>= 0`). Not written when 0.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub fade_out: Time,
}

fn unit() -> f32 {
    1.0
}
fn is_unit(v: &f32) -> bool {
    *v == 1.0
}
fn is_zero(t: &Time) -> bool {
    *t == Time::ZERO
}

impl Default for ClipAudio {
    fn default() -> Self {
        ClipAudio {
            volume: 1.0,
            fade_in: Time::ZERO,
            fade_out: Time::ZERO,
        }
    }
}

impl ClipAudio {
    pub fn is_default(&self) -> bool {
        *self == ClipAudio::default()
    }

    /// A finite volume in `0..=MAX_VOLUME` and fades `>= 0`. Fades longer than the clip are allowed (a trim can shorten a clip below its
    /// fades, and an undo must always be able to put them back): evaluation shortens them to fit, and the UI offers at most half the clip each.
    pub fn is_in_range(&self) -> bool {
        self.volume.is_finite()
            && (0.0..=MAX_VOLUME).contains(&self.volume)
            && self.fade_in >= Time::ZERO
            && self.fade_out >= Time::ZERO
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_not_written_and_reads_back() {
        let a = ClipAudio::default();
        assert_eq!(serde_json::to_string(&a).unwrap(), "{}");
        assert_eq!(serde_json::from_str::<ClipAudio>("{}").unwrap(), a);
    }

    #[test]
    fn only_what_differs_is_written() {
        let a = ClipAudio {
            volume: 0.5,
            fade_out: Time::from_ticks(100),
            ..Default::default()
        };
        let s = serde_json::to_string(&a).unwrap();
        assert_eq!(s, r#"{"volume":0.5,"fade_out":100}"#);
        assert_eq!(serde_json::from_str::<ClipAudio>(&s).unwrap(), a);
    }

    #[test]
    fn range_checks() {
        let ok = |a: ClipAudio| a.is_in_range();
        assert!(ok(ClipAudio::default()));
        assert!(ok(ClipAudio {
            volume: 2.0,
            ..Default::default()
        }));
        assert!(!ok(ClipAudio {
            volume: 2.01,
            ..Default::default()
        }));
        assert!(!ok(ClipAudio {
            volume: -0.1,
            ..Default::default()
        }));
        assert!(!ok(ClipAudio {
            volume: f32::NAN,
            ..Default::default()
        }));
        assert!(!ok(ClipAudio {
            fade_in: Time::from_ticks(-1),
            ..Default::default()
        }));
    }
}
