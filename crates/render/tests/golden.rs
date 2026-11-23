//! Golden-frame harness (S2 / M1-020, extended by M1-021). Renders scenes on every wgpu backend that has an adapter here and compares to PNG goldens
//! within a per-channel tolerance. Backends with no adapter are skipped with a message, never failed (CI containers may have no GPU/software driver).
//! Regenerate goldens: `UPDATE_GOLDENS=1 cargo test -p app-render --test golden` (renders on the first available backend).
#![cfg(not(target_arch = "wasm32"))]

use app_render::{
    headless_compositor, headless_compositor_with, rgb_to_yuv, AccumFormat, Layer, Pixels,
    YuvMatrix, YuvRange,
};
use std::path::PathBuf;

/// Per-channel tolerance in 8-bit code values: covers rasteriser and filtering differences between drivers; real regressions are far larger.
const TOL: u8 = 3;
/// The 8-bit sRGB accumulation fallback rounds every layer; allowed to be this far from the float path (documented in docs/features/render.md).
const TOL_FALLBACK: u8 = 3;

/// GPU tests run one at a time: they share one process-wide device per backend (see `headless_compositor_with`), and software rasterisers
/// (llvmpipe/lavapipe) already use every core, so parallel tests add contention and crash risk, not speed.
fn gpu() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

const BACKENDS: [(&str, wgpu::Backends); 2] = [
    ("vulkan", wgpu::Backends::VULKAN),
    ("gl", wgpu::Backends::GL),
];

struct Img {
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}
impl Img {
    fn from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Img {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&f(x, y));
            }
        }
        Img { w, h, rgba }
    }
    fn layer(&self, center: [f32; 2], scale: [f32; 2], rotation: f32, opacity: f32) -> Layer<'_> {
        Layer {
            width: self.w,
            height: self.h,
            pixels: Pixels::Rgba8Srgb(&self.rgba),
            center,
            scale,
            rotation,
            opacity,
            display_rotation: 0,
        }
    }
}

fn gradient(w: u32, h: u32) -> Img {
    Img::from_fn(w, h, |x, y| {
        [
            (x * 255 / (w - 1)) as u8,
            (y * 255 / (h - 1)) as u8,
            128,
            255,
        ]
    })
}
fn checker(w: u32, h: u32) -> Img {
    Img::from_fn(w, h, |x, y| {
        if ((x / 8) + (y / 8)) % 2 == 0 {
            [250, 250, 30, 255]
        } else {
            [20, 20, 200, 255]
        }
    })
}
fn disc(w: u32, h: u32) -> Img {
    Img::from_fn(w, h, |x, y| {
        let (dx, dy) = (x as f32 - w as f32 / 2.0, y as f32 - h as f32 / 2.0);
        let a = if (dx * dx + dy * dy).sqrt() < w as f32 / 2.0 - 1.0 {
            255
        } else {
            0
        };
        [255, 40, 40, a]
    })
}

// ---- Test chart (M1-021): colour bars, grey ramp, alpha edges -------------------------------------------------------------------------------
const CW: u32 = 320;
const CH: u32 = 180;
const BARS: [[u8; 3]; 8] = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 0],
];
/// Opaque base: 8 colour bars (top 100 rows) over a 16-step grey ramp (next 40 rows) over a mid-grey strip for the alpha layers (last 40 rows).
fn chart_base() -> Img {
    Img::from_fn(CW, CH, |x, y| {
        if y < 100 {
            let b = BARS[(x * 8 / CW) as usize];
            [b[0], b[1], b[2], 255]
        } else if y < 140 {
            let g = ((x * 16 / CW) * 17) as u8;
            [g, g, g, 255]
        } else {
            [118, 118, 118, 255]
        }
    })
}
/// White with a horizontal alpha ramp 0..=255 (soft edge) over the bottom strip, left half; hard-edged half-alpha red block on the right.
fn chart_alpha() -> Img {
    Img::from_fn(CW, 40, |x, _| {
        if x < CW / 2 {
            [255, 255, 255, (x * 255 / (CW / 2 - 1)) as u8]
        } else if x < CW * 3 / 4 {
            [255, 0, 0, 128]
        } else {
            [0, 0, 0, 0]
        }
    })
}
fn chart_scene<'a>(base: &'a Img, alpha: &'a Img, dsc: &'a Img) -> Vec<Layer<'a>> {
    vec![
        base.layer([160.0, 90.0], [1.0, 1.0], 0.0, 1.0),
        alpha.layer([160.0, 160.0], [1.0, 1.0], 0.0, 1.0),
        dsc.layer([260.0, 50.0], [1.0, 1.0], 0.0, 0.8), // anti-aliased-by-sampling disc edge over the bars
    ]
}

fn golden_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/golden/{name}.png"))
}
fn read_png(p: &PathBuf) -> Vec<u8> {
    let d = png::Decoder::new(std::io::BufReader::new(
        std::fs::File::open(p).expect("golden missing: run with UPDATE_GOLDENS=1"),
    ));
    let mut r = d.read_info().unwrap();
    let mut b = vec![0; r.output_buffer_size().unwrap()];
    let i = r.next_frame(&mut b).unwrap();
    b.truncate(i.buffer_size());
    b
}
fn write_png(p: &PathBuf, w: u32, h: u32, rgba: &[u8]) {
    let mut e = png::Encoder::new(
        std::io::BufWriter::new(std::fs::File::create(p).unwrap()),
        w,
        h,
    );
    e.set_color(png::ColorType::Rgba);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(rgba).unwrap();
}
fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

/// Render `layers` on every available backend (and, with `fallback`, also with the 8-bit accumulation) and compare to the named golden.
fn check_golden(name: &str, w: u32, h: u32, layers: &[Layer]) {
    let mut frames: Vec<(String, Vec<u8>, u8)> = vec![];
    for (bname, b) in BACKENDS {
        for (label, force, tol) in [
            ("float", None, TOL),
            ("srgb8", Some(AccumFormat::Srgb8), TOL_FALLBACK),
        ] {
            match headless_compositor_with(b, force) {
                Some((mut c, info)) => {
                    eprintln!(
                        "[{name}/{bname}/{label}] adapter: {} ({:?}), accum {:?}",
                        info.name,
                        info.device_type,
                        c.accum_format()
                    );
                    frames.push((
                        format!("{bname}/{label}"),
                        c.render_to_rgba8(w, h, layers),
                        tol,
                    ));
                }
                None => {
                    eprintln!("[{name}/{bname}] SKIPPED: no adapter available in this environment")
                }
            }
        }
    }
    if frames.is_empty() {
        eprintln!("SKIPPED: no wgpu adapter on any backend (install mesa-vulkan-drivers / libgl1-mesa-dri to run the golden tests)");
        return;
    }
    if std::env::var("UPDATE_GOLDENS").is_ok() {
        write_png(&golden_path(name), w, h, &frames[0].1);
        eprintln!("golden {name} updated from {}", frames[0].0);
        return;
    }
    let golden = read_png(&golden_path(name));
    for (label, f, tol) in &frames {
        let d = max_diff(f, &golden);
        eprintln!("[{name}/{label}] max per-channel diff vs golden: {d} (tolerance {tol})");
        assert!(
            d <= *tol,
            "{name}/{label}: differs from golden by {d} > {tol}"
        );
    }
}

#[test]
fn three_layers_match_golden_on_every_available_backend() {
    let _gpu = gpu();
    let (g, c, d) = (gradient(64, 36), checker(64, 64), disc(64, 64));
    let scene = [
        g.layer([128.0, 72.0], [4.0, 4.0], 0.0, 1.0),
        c.layer([90.0, 80.0], [1.2, 1.2], 0.5, 0.7),
        d.layer([170.0, 70.0], [1.5, 1.0], -0.3, 0.5),
    ];
    check_golden("three_layers", 256, 144, &scene);
}

#[test]
fn colour_chart_matches_golden() {
    let _gpu = gpu();
    let (base, alpha, dsc) = (chart_base(), chart_alpha(), disc(48, 48));
    check_golden("colour_chart", CW, CH, &chart_scene(&base, &alpha, &dsc));
}

fn px(frame: &[u8], w: u32, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * w + x) * 4) as usize;
    [frame[i], frame[i + 1], frame[i + 2]]
}

#[test]
fn chart_values_are_colour_correct() {
    let _gpu = gpu();
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    let (base, alpha, dsc) = (chart_base(), chart_alpha(), disc(48, 48));
    let f = c.render_to_rgba8(CW, CH, &chart_scene(&base, &alpha, &dsc));
    // Colour bars: opaque, so pure primaries survive exactly (disc covers x 236..284, y 26..74: sample bars left of it).
    for (i, b) in BARS.iter().enumerate().take(5) {
        let got = px(&f, CW, i as u32 * 40 + 20, 10);
        assert!(max_diff(&got, b) <= 1, "bar {i}: {got:?} vs {b:?}");
    }
    // Grey ramp: 16 steps, every step an exact sRGB round trip.
    for s in 0..16u32 {
        let g = (s * 17) as u8;
        let got = px(&f, CW, s * 20 + 10, 120);
        assert!(
            max_diff(&got, &[g, g, g]) <= 1,
            "grey step {s}: {got:?} vs {g}"
        );
    }
    // Alpha ramp over mid grey is monotonic and ends at the layer colour: x=0 -> base grey, right end of ramp -> white.
    let left = px(&f, CW, 0, 160);
    assert!(max_diff(&left, &[118, 118, 118]) <= 2, "{left:?}");
    let mut prev = 0;
    for x in (0..CW / 2).step_by(8) {
        let v = px(&f, CW, x, 160)[0];
        assert!(v >= prev, "alpha ramp not monotonic at x={x}");
        prev = v;
    }
    assert!(px(&f, CW, CW / 2 - 2, 160)[0] >= 250);
}

#[test]
fn compositing_is_linear_not_gamma() {
    let _gpu = gpu();
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    // White at 50% over black: 0.5 in linear light encodes to ~188 (a gamma-space blend would give 128).
    let white = Img::from_fn(2, 2, |_, _| [255, 255, 255, 255]);
    let half = c.render_to_rgba8(4, 4, &[white.layer([2.0, 2.0], [2.0, 2.0], 0.0, 0.5)]);
    assert!((187..=189).contains(&half[0]), "got {}", half[0]);
    // 50% alpha in the pixel itself behaves like 50% opacity.
    let a = Img::from_fn(2, 2, |_, _| [255, 255, 255, 128]);
    let q = c.render_to_rgba8(4, 4, &[a.layer([2.0, 2.0], [2.0, 2.0], 0.0, 1.0)]);
    assert!((187..=190).contains(&q[0]), "got {}", q[0]);
}

#[test]
fn opacity_zero_layer_leaves_black_and_full_opacity_is_srgb_exact() {
    let _gpu = gpu();
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    let img = Img::from_fn(2, 2, |_, _| [200, 100, 50, 255]);
    let mut px = |o: f32| {
        c.render_to_rgba8(4, 4, &[img.layer([2.0, 2.0], [2.0, 2.0], 0.0, o)])[..4].to_vec()
    };
    assert_eq!(px(0.0), vec![0, 0, 0, 255]);
    let full = px(1.0);
    assert!(
        max_diff(&full, &[200, 100, 50, 255]) <= 1,
        "opaque layer must round-trip sRGB, got {full:?}"
    );
}

// ---- YUV (video frames) ------------------------------------------------------------------------------------------------------------------------
/// 8 BT.709 bars as a 4:2:0 frame (each bar is a flat block, so chroma subsampling is exact). Returns (y, u, v) planes for `w x h`, `w` multiple of 16.
fn yuv_bars(w: u32, h: u32, range: YuvRange, matrix: YuvMatrix) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let (mut y, mut u, mut v) = (vec![], vec![], vec![]);
    let code = |x: u32| {
        let b = BARS[(x * 8 / w) as usize];
        rgb_to_yuv(
            [
                b[0] as f32 / 255.0,
                b[1] as f32 / 255.0,
                b[2] as f32 / 255.0,
            ],
            range,
            matrix,
        )
    };
    for _ in 0..h {
        for x in 0..w {
            y.push(code(x)[0]);
        }
    }
    for _ in 0..h / 2 {
        for x in 0..w / 2 {
            let c = code(x * 2);
            u.push(c[1]);
            v.push(c[2]);
        }
    }
    (y, u, v)
}

#[test]
fn yuv_bars_decode_to_the_original_colours_for_range_and_matrix() {
    let _gpu = gpu();
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    let (w, h) = (64u32, 32u32);
    for range in [YuvRange::Limited, YuvRange::Full] {
        for matrix in [YuvMatrix::Bt709, YuvMatrix::Bt601] {
            let (y, u, v) = yuv_bars(w, h, range, matrix);
            let l = Layer {
                width: w,
                height: h,
                pixels: Pixels::Yuv420 {
                    y: &y,
                    u: &u,
                    v: &v,
                    range,
                    matrix,
                },
                center: [w as f32 / 2.0, h as f32 / 2.0],
                scale: [1.0, 1.0],
                rotation: 0.0,
                opacity: 1.0,
                display_rotation: 0,
            };
            let f = c.render_to_rgba8(w, h, &[l]);
            for (i, b) in BARS.iter().enumerate() {
                let got = px(&f, w, i as u32 * 8 + 4, 16);
                assert!(
                    max_diff(&got, b) <= 3,
                    "{range:?} {matrix:?} bar {i}: got {got:?}, want {b:?}"
                );
            }
        }
    }
}

#[test]
fn yuv_range_flag_matters() {
    let _gpu = gpu();
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    // Y=235 U=V=128: white if limited, merely light grey if full.
    let (y, u, v) = (vec![235u8; 4 * 4], vec![128u8; 4], vec![128u8; 4]);
    let mut out = |range| {
        let l = Layer {
            width: 4,
            height: 4,
            pixels: Pixels::Yuv420 {
                y: &y,
                u: &u,
                v: &v,
                range,
                matrix: YuvMatrix::Bt709,
            },
            center: [2.0, 2.0],
            scale: [1.0, 1.0],
            rotation: 0.0,
            opacity: 1.0,
            display_rotation: 0,
        };
        c.render_to_rgba8(4, 4, &[l])[0]
    };
    assert!(out(YuvRange::Limited) >= 254);
    assert!((out(YuvRange::Full) as i32 - 235).abs() <= 1);
}

// ---- Hot path ----------------------------------------------------------------------------------------------------------------------------------
#[test]
fn steady_state_frames_create_no_gpu_objects() {
    let _gpu = gpu();
    for (bname, b) in BACKENDS {
        let Some((mut c, info)) = headless_compositor(b) else {
            eprintln!("[{bname}] SKIPPED: no adapter");
            continue;
        };
        let (w, h) = (1920u32, 1080u32);
        // 3 layers like the preview budget: two RGBA, one video (YUV 4:2:0), all 1080p.
        let a = Img::from_fn(w, h, |x, y| [(x % 256) as u8, (y % 256) as u8, 90, 255]);
        let b2 = Img::from_fn(w, h, |x, _| [30, (x % 256) as u8, 200, 200]);
        let (yp, up, vp) = (
            vec![90u8; (w * h) as usize],
            vec![120u8; (w / 2 * h / 2) as usize],
            vec![140u8; (w / 2 * h / 2) as usize],
        );
        let vid = Layer {
            width: w,
            height: h,
            pixels: Pixels::Yuv420 {
                y: &yp,
                u: &up,
                v: &vp,
                range: YuvRange::Limited,
                matrix: YuvMatrix::Bt709,
            },
            center: [960.0, 540.0],
            scale: [0.5, 0.5],
            rotation: 0.2,
            opacity: 0.8,
            display_rotation: 0,
        };
        let layers = [
            a.layer([960.0, 540.0], [1.0, 1.0], 0.0, 1.0),
            b2.layer([700.0, 400.0], [0.6, 0.6], 0.3, 0.7),
            vid,
        ];
        // Warm-up frame creates everything; a 4th resize-free frame sequence must not create anything.
        c.render(w, h, &layers);
        let warm = c.alloc_stats();
        let n = 20;
        let t0 = std::time::Instant::now();
        for _ in 0..n {
            c.render(w, h, &layers);
            let _ = c.device().poll(wgpu::PollType::Wait);
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;
        eprintln!(
            "[{bname}] {} ({:?}): 1080p, 3 layers, {ms:.1} ms/frame (submit+GPU wait, software rasteriser: not representative); GPU objects {warm:?}",
            info.name, info.device_type
        );
        assert_eq!(
            c.alloc_stats(),
            warm,
            "[{bname}] GPU objects created in steady state"
        );
        // Readback buffer is created once, then reused.
        let mut out = Vec::new();
        pollster::block_on(c.read_rgba8_into(w, h, &layers, &mut out)).unwrap();
        let after_first_read = c.alloc_stats();
        let cap = out.capacity();
        pollster::block_on(c.read_rgba8_into(w, h, &layers, &mut out)).unwrap();
        assert_eq!(
            c.alloc_stats(),
            after_first_read,
            "[{bname}] readback re-allocated"
        );
        assert_eq!(out.capacity(), cap);
        assert_eq!(out.len(), (w * h * 4) as usize);
    }
}

#[test]
fn changing_layer_count_or_size_only_rebuilds_what_changed() {
    let _gpu = gpu();
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    let a = Img::from_fn(8, 8, |_, _| [255, 0, 0, 255]);
    let bigger = Img::from_fn(16, 16, |_, _| [0, 255, 0, 255]);
    fn l(i: &Img) -> Layer<'_> {
        i.layer([8.0, 8.0], [1.0, 1.0], 0.0, 1.0)
    }
    c.render(16, 16, &[l(&a)]);
    let s1 = c.alloc_stats();
    c.render(16, 16, &[l(&a), l(&a)]); // one more slot
    let s2 = c.alloc_stats();
    assert_eq!(s2.textures, s1.textures + 1);
    assert_eq!(s2.bind_groups, s1.bind_groups + 1);
    c.render(16, 16, &[l(&a)]); // fewer layers: nothing created
    assert_eq!(c.alloc_stats(), s2);
    c.render(16, 16, &[l(&bigger), l(&a)]); // slot 0 resized: one texture + one bind group
    let s3 = c.alloc_stats();
    assert_eq!(s3.textures, s2.textures + 1);
    assert_eq!(s3.bind_groups, s2.bind_groups + 1);
    let f = c.render_to_rgba8(16, 16, &[l(&bigger)]);
    assert_eq!(&f[..4], &[0, 255, 0, 255]);
}

// ---- M1-023: display rotation, resident pixels, render into a caller's view (the preview surface path) -------------------------------------

/// 4x2 image: left half red, right half blue; top row has a green marker at x = 0.
fn rot_img() -> Img {
    Img::from_fn(4, 2, |x, y| {
        if x == 0 && y == 0 {
            [0, 255, 0, 255]
        } else if x < 2 {
            [255, 0, 0, 255]
        } else {
            [0, 0, 255, 255]
        }
    })
}

#[test]
fn display_rotation_makes_the_layer_upright_and_swaps_its_size() {
    let Some((mut c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    let img = rot_img();
    let mut l = img.layer([2.0, 2.0], [1.0, 1.0], 0.0, 1.0);
    // Output 4x4: the 4x2 picture displayed at 90 is 2 wide x 4 tall, centred: columns 1..3 are covered, columns 0 and 3 stay black.
    l.display_rotation = 90;
    let f = c.render_to_rgba8(4, 4, &[l]);
    assert_eq!(px(&f, 4, 0, 1), [0, 0, 0]);
    assert_eq!(px(&f, 4, 3, 1), [0, 0, 0]);
    // Rotated clockwise by 90: the coded left half (red) ends up on top, the right half (blue) on the bottom; the coded top-left marker lands top-right.
    assert_eq!(
        px(&f, 4, 1, 0),
        [255, 0, 0].map(|v| v),
        "top-left of the upright picture"
    );
    assert_eq!(px(&f, 4, 2, 0), [0, 255, 0], "marker moved top-right");
    assert_eq!(px(&f, 4, 1, 3), [0, 0, 255]);
    // 180 and 270 and four quarter turns (360) behave: 360 equals 0.
    let mut a = img.layer([2.0, 1.0], [1.0, 1.0], 0.0, 1.0);
    let base = c.render_to_rgba8(4, 2, &[a]);
    a.display_rotation = 360;
    assert_eq!(c.render_to_rgba8(4, 2, &[a]), base);
    a.display_rotation = 180;
    let r = c.render_to_rgba8(4, 2, &[a]);
    assert_eq!(
        px(&r, 4, 3, 1),
        [0, 255, 0],
        "marker at bottom-right after 180"
    );
    assert_eq!(px(&r, 4, 0, 0), [0, 0, 255]);
}

#[test]
fn resident_layers_and_rendering_into_a_view_match_the_uploaded_readback_exactly() {
    for (name, backend) in BACKENDS {
        let Some((mut c, _)) = headless_compositor(backend) else {
            eprintln!("SKIPPED {name}: no adapter");
            continue;
        };
        let (w, h) = (96u32, 54u32);
        let g = gradient(64, 36);
        let k = checker(32, 32);
        let mk = |g: &Img, k: &Img| -> [Layer<'static>; 2] {
            let base = |i: &Img, center, scale, rotation, opacity| Layer {
                width: i.w,
                height: i.h,
                pixels: Pixels::Resident,
                center,
                scale,
                rotation,
                opacity,
                display_rotation: 0,
            };
            [
                base(g, [48.0, 27.0], [1.5, 1.5], 0.0, 1.0),
                base(k, [60.0, 30.0], [1.0, 1.0], 0.4, 0.7),
            ]
        };
        // Reference: pixels uploaded by `render` (the export readback path).
        let reference = c.render_to_rgba8(
            w,
            h,
            &[
                g.layer([48.0, 27.0], [1.5, 1.5], 0.0, 1.0),
                k.layer([60.0, 30.0], [1.0, 1.0], 0.4, 0.7),
            ],
        );
        // Resident slots + render into a caller texture (stands in for the canvas surface of the preview).
        c.set_layer_rgba(0, g.w, g.h, &g.rgba);
        c.set_layer_rgba(1, k.w, k.h, &k.rgba);
        let target = c.device().create_texture(&wgpu::TextureDescriptor {
            label: Some("fake surface"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: app_render::OUTPUT_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        c.render_to_view(w, h, &mk(&g, &k), &view);
        let bpr = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buf = c.device().create_buffer(&wgpu::BufferDescriptor {
            label: Some("rb"),
            size: (bpr * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = c.device().create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        c.queue().submit([enc.finish()]);
        buf.slice(..).map_async(wgpu::MapMode::Read, |r| r.unwrap());
        c.device().poll(wgpu::PollType::Wait).unwrap();
        let data = buf.slice(..).get_mapped_range();
        let mut got = Vec::new();
        for row in data.chunks(bpr as usize).take(h as usize) {
            got.extend_from_slice(&row[..(w * 4) as usize]);
        }
        assert_eq!(
            got, reference,
            "{name}: view path and readback path must be identical"
        );
    }
}
