//! Integer-tick time (ADR 0010). Floats are never used for timeline positions.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Ticks per second. Divides exactly into one frame of 24, 25, 30, 48, 50, 60, 120 fps and the
/// NTSC rates 24000/1001, 30000/1001, 60000/1001, and into one sample of 44.1, 48, 88.2, 96, 192 kHz.
pub const TICKS_PER_SECOND: i64 = 705_600_000;

/// A point in time or a duration, in ticks. Serialized as a plain integer.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
)]
#[serde(transparent)]
pub struct Time(i64);

impl Time {
    pub const ZERO: Time = Time(0);

    pub const fn from_ticks(ticks: i64) -> Time {
        Time(ticks)
    }

    pub const fn ticks(self) -> i64 {
        self.0
    }

    pub fn checked_add(self, other: Time) -> Option<Time> {
        self.0.checked_add(other.0).map(Time)
    }

    pub fn checked_sub(self, other: Time) -> Option<Time> {
        self.0.checked_sub(other.0).map(Time)
    }

    /// Whole seconds as ticks; `None` on overflow.
    pub fn from_seconds(seconds: i64) -> Option<Time> {
        seconds.checked_mul(TICKS_PER_SECOND).map(Time)
    }

    /// Microseconds (WebCodecs boundary), rounded to the nearest tick, ties away from zero.
    pub fn from_micros(micros: i64) -> Option<Time> {
        // ticks = micros * 705.6 = micros * 3528 / 5
        let n = i128::from(micros) * 3528;
        i64::try_from(div_round(n, 5)).ok().map(Time)
    }

    /// Microseconds, rounded toward negative infinity (floor), for browser APIs.
    pub fn to_micros_floor(self) -> i64 {
        // micros = ticks * 5 / 3528; always fits since |result| < |ticks|
        i64::try_from(div_floor(i128::from(self.0) * 5, 3528)).unwrap_or(i64::MAX)
    }

    /// Index of the frame that contains this time (floor). `None` if `fps` is not positive.
    pub fn frame_index(self, fps: Rational) -> Option<i64> {
        let num = i128::from(self.0) * i128::from(fps.num);
        let den = i128::from(TICKS_PER_SECOND) * i128::from(fps.den);
        i64::try_from(div_floor(num, den))
            .ok()
            .filter(|_| fps.num > 0)
    }

    /// Time at which frame `index` starts, rounded to the nearest tick (exact for the standard rates).
    pub fn from_frame_index(index: i64, fps: Rational) -> Option<Time> {
        if fps.num <= 0 {
            return None;
        }
        let n = i128::from(index) * i128::from(fps.den) * i128::from(TICKS_PER_SECOND);
        i64::try_from(div_round(n, i128::from(fps.num)))
            .ok()
            .map(Time)
    }

    /// Index of the audio sample that contains this time (floor).
    pub fn sample_index(self, rate_hz: u32) -> Option<i64> {
        if rate_hz == 0 {
            return None;
        }
        let n = i128::from(self.0) * i128::from(rate_hz);
        i64::try_from(div_floor(n, i128::from(TICKS_PER_SECOND))).ok()
    }

    /// Time at which audio sample `index` starts, rounded to the nearest tick.
    pub fn from_sample_index(index: i64, rate_hz: u32) -> Option<Time> {
        if rate_hz == 0 {
            return None;
        }
        let n = i128::from(index) * i128::from(TICKS_PER_SECOND);
        i64::try_from(div_round(n, i128::from(rate_hz)))
            .ok()
            .map(Time)
    }
}

impl std::ops::Add for Time {
    type Output = Time;
    fn add(self, o: Time) -> Time {
        Time(self.0 + o.0)
    }
}

impl std::ops::Sub for Time {
    type Output = Time;
    fn sub(self, o: Time) -> Time {
        Time(self.0 - o.0)
    }
}

/// An exact fraction (frame rates, speeds). `den` is always positive and the fraction is reduced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, JsonSchema)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    pub const FPS_24: Rational = Rational { num: 24, den: 1 };
    pub const FPS_25: Rational = Rational { num: 25, den: 1 };
    pub const FPS_30: Rational = Rational { num: 30, den: 1 };
    pub const FPS_60: Rational = Rational { num: 60, den: 1 };
    pub const FPS_23_976: Rational = Rational {
        num: 24000,
        den: 1001,
    };
    pub const FPS_29_97: Rational = Rational {
        num: 30000,
        den: 1001,
    };
    pub const FPS_59_94: Rational = Rational {
        num: 60000,
        den: 1001,
    };

    /// `None` if `den` is zero or the reduction overflows (only for `i64::MIN`).
    pub fn new(num: i64, den: i64) -> Option<Rational> {
        if den == 0 {
            return None;
        }
        let (mut n, mut d) = (num.checked_mul(den.signum())?, den.checked_abs()?);
        let g = gcd(n.unsigned_abs(), d.unsigned_abs());
        if g > 1 {
            n /= g as i64;
            d /= g as i64;
        }
        Some(Rational { num: n, den: d })
    }

    /// Duration of one frame at this rate, if it is a whole number of ticks.
    pub fn frame_duration(self) -> Option<Time> {
        if self.num <= 0 {
            return None;
        }
        let n = i128::from(TICKS_PER_SECOND) * i128::from(self.den);
        let q = n / i128::from(self.num);
        (q * i128::from(self.num) == n).then(|| i64::try_from(q).ok().map(Time))?
    }
}

impl<'de> Deserialize<'de> for Rational {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            num: i64,
            den: i64,
        }
        let r = Raw::deserialize(d)?;
        Rational::new(r.num, r.den)
            .ok_or_else(|| serde::de::Error::custom("rational denominator must be non-zero"))
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

fn div_floor(n: i128, d: i128) -> i128 {
    n.div_euclid(d) - i128::from(d < 0 && n.rem_euclid(d) != 0)
}

/// Round to nearest, ties away from zero. `d` must be positive.
fn div_round(n: i128, d: i128) -> i128 {
    let h = d / 2;
    if n >= 0 {
        (n + h) / d
    } else {
        (n - h) / d
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATES: [Rational; 7] = [
        Rational::FPS_24,
        Rational::FPS_25,
        Rational::FPS_30,
        Rational::FPS_60,
        Rational::FPS_23_976,
        Rational::FPS_29_97,
        Rational::FPS_59_94,
    ];

    #[test]
    fn standard_frame_rates_divide_exactly() {
        for r in RATES {
            assert!(r.frame_duration().is_some(), "{r:?}");
        }
        assert_eq!(
            Rational::FPS_30.frame_duration(),
            Some(Time::from_ticks(23_520_000))
        );
        assert_eq!(Rational::new(11, 1).unwrap().frame_duration(), None);
    }

    #[test]
    fn standard_sample_rates_divide_exactly() {
        for hz in [44_100u32, 48_000, 88_200, 96_000, 192_000] {
            assert_eq!(TICKS_PER_SECOND % i64::from(hz), 0, "{hz}");
        }
    }

    #[test]
    fn frame_round_trip_and_floor() {
        for r in RATES {
            let d = r.frame_duration().unwrap().ticks();
            for i in [-5i64, 0, 1, 2, 29, 1000, 1_000_000] {
                let t = Time::from_frame_index(i, r).unwrap();
                assert_eq!(t.ticks(), i * d);
                assert_eq!(t.frame_index(r), Some(i));
                // last tick before the next frame is still frame i; one tick before is the previous frame
                assert_eq!((t + Time::from_ticks(d - 1)).frame_index(r), Some(i));
                assert_eq!((t - Time::from_ticks(1)).frame_index(r), Some(i - 1));
            }
        }
    }

    #[test]
    fn samples_round_trip() {
        for hz in [44_100u32, 48_000, 96_000] {
            for i in [-3i64, 0, 1, 12_345, 48_000 * 3600] {
                let t = Time::from_sample_index(i, hz).unwrap();
                assert_eq!(t.sample_index(hz), Some(i));
            }
        }
        assert_eq!(Time::ZERO.sample_index(0), None);
    }

    #[test]
    fn micros_boundary() {
        assert_eq!(Time::from_seconds(1).unwrap().to_micros_floor(), 1_000_000);
        assert_eq!(Time::from_micros(1_000_000), Time::from_seconds(1));
        assert_eq!(Time::from_ticks(-1).to_micros_floor(), -1); // floor
        for us in [0i64, 1, 33_333, 41_666, 3_600_000_000] {
            // micros -> ticks -> micros is lossless
            assert_eq!(Time::from_micros(us).unwrap().to_micros_floor(), us);
        }
    }

    #[test]
    fn monotonic_frame_index_random() {
        // deterministic LCG, no external deps
        let mut x: u64 = 0x2545F4914F6CDD1D;
        let mut prev = i64::MIN;
        let mut ts: Vec<i64> = (0..2000)
            .map(|_| {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (x >> 20) as i64 % (TICKS_PER_SECOND * 7200)
            })
            .collect();
        ts.sort_unstable();
        for t in ts {
            let f = Time::from_ticks(t)
                .frame_index(Rational::FPS_29_97)
                .unwrap();
            assert!(f >= prev);
            prev = f;
        }
    }

    #[test]
    fn overflow_is_none_not_panic() {
        assert_eq!(Time::from_seconds(i64::MAX), None);
        assert_eq!(
            Time::from_ticks(i64::MAX).checked_add(Time::from_ticks(1)),
            None
        );
        assert_eq!(Time::from_frame_index(i64::MAX, Rational::FPS_24), None);
    }

    #[test]
    fn rational_normalises_and_validates() {
        assert_eq!(Rational::new(60, 2), Rational::new(30, 1));
        assert_eq!(Rational::new(1, -2), Some(Rational { num: -1, den: 2 }));
        assert_eq!(Rational::new(1, 0), None);
        assert_eq!(Rational::new(i64::MIN, -1), None);
        assert!(serde_json::from_str::<Rational>(r#"{"num":1,"den":0}"#).is_err());
        let r: Rational = serde_json::from_str(r#"{"num":60,"den":2}"#).unwrap();
        assert_eq!(r, Rational::FPS_30);
    }

    #[test]
    fn time_serializes_as_plain_integer() {
        assert_eq!(serde_json::to_string(&Time::from_ticks(42)).unwrap(), "42");
        assert_eq!(
            serde_json::from_str::<Time>("42").unwrap(),
            Time::from_ticks(42)
        );
    }
}
