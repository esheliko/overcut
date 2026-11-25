//! Time-scale modification that keeps pitch (clip speed, `docs/features/speed.md`): WSOLA (waveform-similarity overlap-add).
//!
//! Own code, no third-party DSP (no licence to check against `docs/adr/0004-media-io.md`). Output frame `k` starts at `k * hop` in the output
//! and reads the input near `k * hop * speed`; the exact start is the one within `+-tolerance` whose first `overlap` samples best match
//! the samples that would naturally have followed the previous frame (smallest squared difference on a mono mix), so waveforms line up
//! at the join. Frames are Hann-windowed at 50% overlap and added (the windows sum to 1). One input in, one output out: deterministic,
//! no hidden state, the same code for preview and export.

use std::f32::consts::PI;

/// Frame length in seconds. Long enough to hold a few periods of a low voice, short enough not to smear transients.
const FRAME_SECONDS: f32 = 0.025;
/// How far from the nominal position a frame may slide, in seconds.
const TOLERANCE_SECONDS: f32 = 0.010;

/// Number of output samples for `input_len` input samples at `num/den` speed (`ceil(input_len * den / num)`).
pub fn output_len(input_len: usize, num: u32, den: u32) -> usize {
    if num == 0 {
        return 0;
    }
    (input_len as u128 * u128::from(den)).div_ceil(u128::from(num)) as usize
}

/// Stretches planar `channels` (all the same length) by `num/den` (> 1 = faster = shorter) at sample rate `rate`.
/// The result has `output_len(len, num, den)` samples per channel; the pitch is unchanged.
pub fn stretch(channels: &[&[f32]], rate: u32, num: u32, den: u32) -> Vec<Vec<f32>> {
    let len = channels.first().map_or(0, |c| c.len());
    let out_len = output_len(len, num, den);
    if num == den || len == 0 || out_len == 0 {
        // Speed 1 (or nothing to do): a plain copy, padded or cut to the length.
        return channels
            .iter()
            .map(|c| {
                let mut v = c.to_vec();
                v.resize(out_len, 0.0);
                v
            })
            .collect();
    }
    let speed = f64::from(num) / f64::from(den);
    let frame = ((rate as f32 * FRAME_SECONDS) as usize).max(16) & !1; // even
    let half = frame / 2;
    let tol = ((rate as f32 * TOLERANCE_SECONDS) as usize).max(1);
    let window: Vec<f32> = (0..frame)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / frame as f32).cos())
        .collect();
    let mono: Vec<f32> = (0..len)
        .map(|i| channels.iter().map(|c| c[i]).sum::<f32>() / channels.len() as f32)
        .collect();
    let at = |buf: &[f32], i: i64| -> f32 {
        if i < 0 {
            0.0
        } else {
            buf.get(i as usize).copied().unwrap_or(0.0)
        }
    };
    // Slower than 1: frames are placed `half` apart in the output and read closer together. Faster: frames are read `half` apart (so the
    // Hann windows tile the input evenly and no click lands on a window edge) and placed closer together in the output. Either way the
    // overlapping output windows are summed and divided by their own sum.
    let out_hop = if speed < 1.0 {
        half as f64
    } else {
        half as f64 / speed
    };

    let pad = out_len + 2 * frame;
    let mut out = vec![vec![0.0f32; pad]; channels.len()];
    let mut norm = vec![0.0f32; pad];
    let mut prev: i64 = 0; // where the previous frame was read
    let mut prev_o: usize = 0;
    let frames = (out_len as f64 / out_hop).ceil() as usize + 1;
    for k in 0..frames {
        let o = (k as f64 * out_hop).round() as usize;
        let nominal = (o as f64 * speed).round() as i64;
        let pos = if k == 0 {
            nominal
        } else {
            // The samples that would have followed the previous frame, one output hop later, are the target for this frame's head.
            let target = prev + (o - prev_o) as i64;
            // Nearest to the nominal position first, and a candidate must beat the best by a margin: on silence or a flat signal every
            // candidate ties and the frame stays where the clock puts it (it must not drift to the edge of the search range).
            // Coarse (every 4th position, every 4th sample), then a fine pass around the winner.
            let ssd = |cand: i64, stride: usize| -> f32 {
                let mut sum = 0.0f32;
                let mut i = 0usize;
                while i < half {
                    let d = at(&mono, cand + i as i64) - at(&mono, target + i as i64);
                    sum += d * d;
                    i += stride;
                }
                sum / (half / stride) as f32
            };
            let mut best = (f32::MAX, nominal);
            for d in 0..=(2 * tol as i64 / 4) {
                let cand = nominal + 4 * if d % 2 == 0 { d / 2 } else { -(d + 1) / 2 };
                let v = ssd(cand, 4);
                if v < best.0 * 0.98 {
                    best = (v, cand);
                }
            }
            let centre = best.1;
            let mut fine = (f32::MAX, centre);
            for d in [0i64, 1, -1, 2, -2, 3, -3] {
                let cand = centre + d;
                if (cand - nominal).abs() > tol as i64 {
                    continue;
                }
                let v = ssd(cand, 2);
                if v < fine.0 * 0.98 {
                    fine = (v, cand);
                }
            }
            fine.1
        };
        prev = pos;
        prev_o = o;
        for (i, w) in window.iter().enumerate() {
            norm[o + i] += w;
        }
        for (c, ch) in channels.iter().enumerate() {
            for (i, w) in window.iter().enumerate() {
                out[c][o + i] += w * at(ch, pos + i as i64);
            }
        }
    }
    for ch in &mut out {
        for (v, n) in ch.iter_mut().zip(&norm) {
            // The very first and last half frames have only one window: their weight is below 1, so scale them up (capped).
            *v /= n.max(0.25);
        }
    }
    for ch in &mut out {
        ch.truncate(out_len);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn sine(hz: f32, seconds: f32) -> Vec<f32> {
        (0..(RATE as f32 * seconds) as usize)
            .map(|i| (2.0 * PI * hz * i as f32 / RATE as f32).sin() * 0.5)
            .collect()
    }

    /// Frequency from upward zero crossings in the middle half (away from the edges).
    fn hz(x: &[f32]) -> f32 {
        let (a, b) = (x.len() / 4, x.len() * 3 / 4);
        let n = (a..b).filter(|&i| x[i - 1] < 0.0 && x[i] >= 0.0).count();
        n as f32 * RATE as f32 / (b - a) as f32
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn length_follows_the_speed() {
        let x = sine(220.0, 1.0);
        for (num, den) in [(1, 4), (1, 2), (3, 2), (2, 1), (4, 1), (7, 5)] {
            let y = stretch(&[&x], RATE, num, den);
            assert_eq!(y[0].len(), output_len(x.len(), num, den));
        }
        assert_eq!(output_len(48_000, 2, 1), 24_000);
        assert_eq!(output_len(48_000, 1, 2), 96_000);
        assert_eq!(output_len(5, 2, 1), 3);
    }

    #[test]
    fn pitch_and_level_are_kept() {
        let x = sine(440.0, 2.0);
        for (num, den) in [(1, 4), (1, 2), (3, 2), (2, 1), (4, 1)] {
            let y = &stretch(&[&x], RATE, num, den)[0];
            let f = hz(y);
            assert!((f - 440.0).abs() < 440.0 * 0.02, "{num}/{den}: {f} Hz");
            let (a, b) = (y.len() / 4, y.len() * 3 / 4);
            let ratio = rms(&y[a..b]) / rms(&x);
            assert!((0.9..1.1).contains(&ratio), "{num}/{den}: level {ratio}");
        }
    }

    #[test]
    fn speed_one_is_a_copy_and_all_channels_stay_aligned() {
        let x = sine(300.0, 0.5);
        assert_eq!(stretch(&[&x], RATE, 3, 3)[0], x);
        let l = sine(300.0, 1.0);
        let r: Vec<f32> = l.iter().map(|v| -v).collect();
        let y = stretch(&[&l, &r], RATE, 2, 1);
        assert!(y[0].iter().zip(&y[1]).all(|(a, b)| (a + b).abs() < 1e-6));
    }

    #[test]
    fn empty_and_tiny_inputs_do_not_panic() {
        assert!(stretch(&[], RATE, 2, 1).is_empty());
        assert_eq!(stretch(&[&[]], RATE, 2, 1)[0].len(), 0);
        assert_eq!(stretch(&[&[0.5; 3]], RATE, 1, 4)[0].len(), 12);
    }

    /// Sync check with the click/flash fixture's audio (silence plus a 3 ms 2 kHz click at the start of every source second,
    /// `crates/media/tests/fixtures/flash_click.mp4`, `make.sh`): after a stretch each click must sit at `source time / speed` (within a
    /// frame's tolerance), so the sound stays on its picture.
    #[test]
    fn clicks_stay_on_their_flashes() {
        let seconds = 4;
        let mut x = vec![0.0f32; RATE as usize * seconds];
        for s in 0..seconds {
            for i in 0..(RATE as usize * 3 / 1000) {
                x[s * RATE as usize + i] = (2.0 * PI * 2000.0 * i as f32 / RATE as f32).sin() * 0.8;
            }
        }
        for (num, den) in [(1, 4), (1, 2), (3, 2), (2, 1), (4, 1)] {
            let y = &stretch(&[&x], RATE, num, den)[0];
            let speed = num as f32 / den as f32;
            let tol = (0.030 * RATE as f32) as usize;
            // Skip the first click (its frame starts at 0) and the last (cut by the end); the middle ones must all be there.
            for s in 1..seconds - 1 {
                let at = (s as f32 * RATE as f32 / speed) as usize;
                let win = &y[at.saturating_sub(tol)..(at + tol).min(y.len())];
                let peak = win.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(
                    peak > 0.25,
                    "{num}/{den}: no click near {:.3}s (peak {peak})",
                    at as f32 / RATE as f32
                );
                let lag =
                    win.iter().position(|v| v.abs() == peak).unwrap() as i64 - tol.min(at) as i64;
                assert!(
                    lag.abs() < tol as i64,
                    "{num}/{den}: click {lag} samples off"
                );
            }
        }
    }
}
