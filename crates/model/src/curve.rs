//! Easing curves on plain `f64`, with no dependencies and no libm: only `+ - * /` and comparisons, which are
//! correctly rounded IEEE-754 operations, so the result is bit-identical on native and WebAssembly
//! (ADR 0015; Rust never fuses multiply-add, and WebAssembly has no fused op without relaxed-simd).

/// Upper bound of solve iterations (Newton needs about 5; the flat-slope cases that fall back to bisection need up to ~45).
const SOLVE_STEPS: u32 = 100;
/// Stop when x(s) is this close to `x` (a deterministic test on the same arithmetic everywhere, not a platform choice).
const SOLVE_TOL: f64 = 1e-15;

/// Cubic bezier easing like CSS `cubic-bezier(x1, y1, x2, y2)`: the curve from (0,0) to (1,1) with control points
/// (x1,y1) and (x2,y2). Maps progress `x` in `[0,1]` to eased progress (`y` may leave `[0,1]`, an overshoot).
/// Requires `x1` and `x2` in `[0,1]` (then x(s) is monotonic and the solve is unique); callers validate that.
///
/// The solve is a safeguarded Newton: a bracket `[lo, hi]` shrinks (a flat slope falls back to bisection, so it always converges)
/// and the Newton step is taken when it stays inside the bracket and the slope is not flat.
pub fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    let mut s = x;
    for _ in 0..SOLVE_STEPS {
        let err = bez(x1, x2, s) - x;
        if err.abs() < SOLVE_TOL || hi - lo < SOLVE_TOL {
            break;
        }
        if err < 0.0 {
            lo = s;
        } else {
            hi = s;
        }
        let slope = bez_slope(x1, x2, s);
        let newton = s - err / slope;
        s = if slope > 1e-6 && newton > lo && newton < hi {
            newton
        } else {
            (lo + hi) * 0.5
        };
    }
    bez(y1, y2, s)
}

/// Derivative of `bez` with respect to `s`.
fn bez_slope(a: f64, b: f64, s: f64) -> f64 {
    let u = 1.0 - s;
    3.0 * u * u * a + 6.0 * u * s * (b - a) + 3.0 * s * s * (1.0 - b)
}

/// One coordinate of the bezier with end points 0 and 1: `3(1-s)^2 s a + 3(1-s) s^2 b + s^3`.
fn bez(a: f64, b: f64, s: f64) -> f64 {
    let u = 1.0 - s;
    3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s
}

/// `v0` at `e = 0` and `v1` at `e = 1` exactly (no rounding error at the ends), linear in between.
pub fn lerp(v0: f64, v1: f64, e: f64) -> f64 {
    v0 * (1.0 - e) + v1 * e
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference: plain bisection to the last bit.
    fn reference(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
        let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
        for _ in 0..100 {
            let s = (lo + hi) * 0.5;
            if bez(x1, x2, s) < x {
                lo = s;
            } else {
                hi = s;
            }
        }
        bez(y1, y2, (lo + hi) * 0.5)
    }

    #[test]
    fn solve_matches_bisection_everywhere() {
        let mut worst = 0.0_f64;
        let grid = [0.0, 0.1, 0.25, 0.42, 0.58, 0.9, 1.0];
        for &x1 in &grid {
            for &x2 in &grid {
                for &(y1, y2) in &[(0.0, 1.0), (-0.5, 1.5), (1.0, 0.0), (0.1, 0.1)] {
                    for i in 1..200 {
                        let x = f64::from(i) / 200.0;
                        let d =
                            (cubic_bezier(x1, y1, x2, y2, x) - reference(x1, y1, x2, y2, x)).abs();
                        worst = worst.max(d);
                    }
                }
            }
        }
        // 1e-5 is the conditioning floor of the degenerate (1,_,0,_) curve whose x(s) has a flat inflection at x = 0.5:
        // there x is exact to the last bit over a range of s about 1e-5 wide; every other control set agrees to < 1e-9.
        assert!(worst < 1e-5, "worst deviation {worst}");
    }
}
