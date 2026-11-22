//! Pure colour maths shared by the CPU reference (tests, charts) and the shader uniforms (ADR 0003, colour pipeline v0).
//!
//! v0 rules: image layers are sRGB (IEC 61966-2-1) and decoded to linear light; video frames are YCbCr (BT.709 by default) decoded to
//! non-linear R'G'B' and then treated as sRGB-encoded (the common display convention; a precise BT.1886 path is a later milestone).
//! Compositing happens in linear light; the output is sRGB-encoded.

/// Quantisation range of a YCbCr frame, from the frame metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YuvRange {
    /// Studio swing: Y 16..=235, Cb/Cr 16..=240 (most video).
    Limited,
    /// Full swing: 0..=255 (JPEG-style, some screen captures).
    Full,
}

/// YCbCr matrix coefficients.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YuvMatrix {
    /// ITU-R BT.709 (HD, the default).
    Bt709,
    /// ITU-R BT.601 (SD).
    Bt601,
}

impl YuvMatrix {
    fn kr_kb(self) -> (f32, f32) {
        match self {
            YuvMatrix::Bt709 => (0.2126, 0.0722),
            YuvMatrix::Bt601 => (0.299, 0.114),
        }
    }
}

/// sRGB-encoded value (0..=1) to linear light.
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light (clamped to 0..=1) to sRGB-encoded.
pub fn linear_to_srgb(l: f32) -> f32 {
    let c = l.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// Uniform parameters for the YUV decode: `([y_offset, y_scale, c_offset, c_scale], [r_cr, g_cb, g_cr, b_cb])`.
/// With `y = (Y - y_offset) * y_scale` and `cb = (U - c_offset) * c_scale` (all inputs 0..=1):
/// `R = y + r_cr*cr`, `G = y - g_cb*cb - g_cr*cr`, `B = y + b_cb*cb`.
pub fn yuv_params(range: YuvRange, matrix: YuvMatrix) -> ([f32; 4], [f32; 4]) {
    let (kr, kb) = matrix.kr_kb();
    let kg = 1.0 - kr - kb;
    let a = match range {
        YuvRange::Limited => [16.0 / 255.0, 255.0 / 219.0, 128.0 / 255.0, 255.0 / 224.0],
        YuvRange::Full => [0.0, 1.0, 128.0 / 255.0, 1.0],
    };
    let b = [
        2.0 * (1.0 - kr),
        2.0 * kb * (1.0 - kb) / kg,
        2.0 * kr * (1.0 - kr) / kg,
        2.0 * (1.0 - kb),
    ];
    (a, b)
}

/// CPU reference: 8-bit Y'CbCr to non-linear R'G'B' in 0..=1 (clamped).
pub fn yuv_to_rgb(y: u8, u: u8, v: u8, range: YuvRange, matrix: YuvMatrix) -> [f32; 3] {
    let (a, b) = yuv_params(range, matrix);
    let yy = (y as f32 / 255.0 - a[0]) * a[1];
    let cb = (u as f32 / 255.0 - a[2]) * a[3];
    let cr = (v as f32 / 255.0 - a[2]) * a[3];
    [
        (yy + b[0] * cr).clamp(0.0, 1.0),
        (yy - b[1] * cb - b[2] * cr).clamp(0.0, 1.0),
        (yy + b[3] * cb).clamp(0.0, 1.0),
    ]
}

/// CPU reference: non-linear R'G'B' (0..=1) to 8-bit Y'CbCr (used to build test frames).
pub fn rgb_to_yuv(rgb: [f32; 3], range: YuvRange, matrix: YuvMatrix) -> [u8; 3] {
    let (kr, kb) = matrix.kr_kb();
    let kg = 1.0 - kr - kb;
    let y = kr * rgb[0] + kg * rgb[1] + kb * rgb[2];
    let cb = (rgb[2] - y) / (2.0 * (1.0 - kb));
    let cr = (rgb[0] - y) / (2.0 * (1.0 - kr));
    let (yo, ys, co, cs) = match range {
        YuvRange::Limited => (16.0, 219.0, 128.0, 224.0),
        YuvRange::Full => (0.0, 255.0, 128.0, 255.0),
    };
    let q = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    [q(yo + ys * y), q(co + cs * cb), q(co + cs * cr)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_round_trips() {
        for i in 0..=255 {
            let c = i as f32 / 255.0;
            assert!((linear_to_srgb(srgb_to_linear(c)) - c).abs() < 1e-5, "{i}");
        }
        // Mid-grey in linear light is far brighter than 0.5 once encoded.
        assert!((linear_to_srgb(0.5) * 255.0 - 188.0).abs() < 1.0);
    }

    #[test]
    fn limited_range_endpoints() {
        let blk = yuv_to_rgb(16, 128, 128, YuvRange::Limited, YuvMatrix::Bt709);
        let wht = yuv_to_rgb(235, 128, 128, YuvRange::Limited, YuvMatrix::Bt709);
        assert!(blk.iter().all(|v| v.abs() < 1e-3), "{blk:?}");
        assert!(wht.iter().all(|v| (v - 1.0).abs() < 1e-3), "{wht:?}");
        // Below black / above white clamp instead of wrapping.
        assert_eq!(
            yuv_to_rgb(0, 128, 128, YuvRange::Limited, YuvMatrix::Bt709),
            [0.0; 3]
        );
        assert_eq!(
            yuv_to_rgb(255, 128, 128, YuvRange::Limited, YuvMatrix::Bt709),
            [1.0; 3]
        );
    }

    #[test]
    fn full_range_differs_from_limited() {
        let lim = yuv_to_rgb(200, 128, 128, YuvRange::Limited, YuvMatrix::Bt709)[0];
        let full = yuv_to_rgb(200, 128, 128, YuvRange::Full, YuvMatrix::Bt709)[0];
        assert!((full - 200.0 / 255.0).abs() < 1e-4);
        assert!(lim > full, "limited stretches 16..235 to 0..1");
    }

    #[test]
    fn bt709_and_bt601_differ_on_saturated_colours() {
        // Same code values, different matrices: the decoded colour must differ visibly.
        let a = yuv_to_rgb(63, 102, 240, YuvRange::Limited, YuvMatrix::Bt709);
        let b = yuv_to_rgb(63, 102, 240, YuvRange::Limited, YuvMatrix::Bt601);
        assert!(
            a[0] > 0.97 && a[1] < 0.03 && a[2] < 0.05,
            "BT.709 red {a:?}"
        );
        let d = (0..3).map(|k| (a[k] - b[k]).abs()).fold(0.0, f32::max);
        assert!(d > 0.05, "matrices must differ, max channel delta {d}");
    }

    #[test]
    fn rgb_yuv_round_trip_within_quantisation() {
        for range in [YuvRange::Limited, YuvRange::Full] {
            for m in [YuvMatrix::Bt709, YuvMatrix::Bt601] {
                for rgb in [[0.8, 0.2, 0.1], [0.1, 0.9, 0.3], [0.3, 0.3, 0.95]] {
                    let [y, u, v] = rgb_to_yuv(rgb, range, m);
                    let back = yuv_to_rgb(y, u, v, range, m);
                    for k in 0..3 {
                        assert!(
                            (back[k] - rgb[k]).abs() < 0.012,
                            "{range:?} {m:?} {rgb:?} -> {back:?}"
                        );
                    }
                }
            }
        }
    }
}
