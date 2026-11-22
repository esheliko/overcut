//! Golden-frame harness (S2 / M1-020). Renders a 3-layer scene on every wgpu backend that has an adapter here and compares to the PNG golden
//! within a per-channel tolerance. Backends with no adapter are skipped with a message, never failed (CI containers may have no GPU/software driver).
//! Regenerate the golden: `UPDATE_GOLDENS=1 cargo test -p app-render --test golden` (renders on the first available backend).
#![cfg(not(target_arch = "wasm32"))]

use app_render::{headless_compositor, Layer};
use std::path::PathBuf;

const W: u32 = 256;
const H: u32 = 144;
/// Per-channel tolerance in 8-bit code values: covers rasteriser and filtering differences between drivers; real regressions are far larger.
const TOL: u8 = 3;

fn gradient(w: u32, h: u32) -> Vec<u8> {
    let mut v = Vec::new();
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&[
                (x * 255 / (w - 1)) as u8,
                (y * 255 / (h - 1)) as u8,
                128,
                255,
            ]);
        }
    }
    v
}
fn checker(w: u32, h: u32) -> Vec<u8> {
    let mut v = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let on = ((x / 8) + (y / 8)) % 2 == 0;
            v.extend_from_slice(if on {
                &[250, 250, 30, 255]
            } else {
                &[20, 20, 200, 255]
            });
        }
    }
    v
}
fn disc(w: u32, h: u32) -> Vec<u8> {
    let mut v = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as f32 - w as f32 / 2.0, y as f32 - h as f32 / 2.0);
            let a = if (dx * dx + dy * dy).sqrt() < w as f32 / 2.0 - 1.0 {
                255
            } else {
                0
            };
            v.extend_from_slice(&[255, 40, 40, a]);
        }
    }
    v
}

fn scene() -> Vec<Layer> {
    let l = |w, h, rgba, c: [f32; 2], s: [f32; 2], r: f32, o: f32| Layer {
        width: w,
        height: h,
        rgba,
        center: c,
        scale: s,
        rotation: r,
        opacity: o,
    };
    vec![
        l(
            64,
            36,
            gradient(64, 36),
            [128.0, 72.0],
            [4.0, 4.0],
            0.0,
            1.0,
        ),
        l(64, 64, checker(64, 64), [90.0, 80.0], [1.2, 1.2], 0.5, 0.7),
        l(64, 64, disc(64, 64), [170.0, 70.0], [1.5, 1.0], -0.3, 0.5),
    ]
}

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/three_layers.png")
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
fn write_png(p: &PathBuf, rgba: &[u8]) {
    let mut e = png::Encoder::new(
        std::io::BufWriter::new(std::fs::File::create(p).unwrap()),
        W,
        H,
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

#[test]
fn three_layers_match_golden_on_every_available_backend() {
    let backends = [
        ("vulkan", wgpu::Backends::VULKAN),
        ("gl", wgpu::Backends::GL),
    ];
    let mut frames: Vec<(&str, Vec<u8>)> = vec![];
    for (name, b) in backends {
        match headless_compositor(b) {
            Some((c, info)) => {
                eprintln!(
                    "[{name}] adapter: {} ({:?}, {:?})",
                    info.name, info.device_type, info.backend
                );
                frames.push((name, c.render_to_rgba8(W, H, &scene())));
            }
            None => eprintln!("[{name}] SKIPPED: no adapter available in this environment"),
        }
    }
    if frames.is_empty() {
        eprintln!("SKIPPED: no wgpu adapter on any backend (install mesa-vulkan-drivers / libgl1-mesa-dri to run the golden test)");
        return;
    }
    if std::env::var("UPDATE_GOLDENS").is_ok() {
        write_png(&golden_path(), &frames[0].1);
        eprintln!("golden updated from {}", frames[0].0);
        return;
    }
    let golden = read_png(&golden_path());
    for (name, f) in &frames {
        let d = max_diff(f, &golden);
        eprintln!("[{name}] max per-channel diff vs golden: {d} (tolerance {TOL})");
        assert!(d <= TOL, "{name}: frame differs from golden by {d} > {TOL}");
    }
    for w in frames.windows(2) {
        let d = max_diff(&w[0].1, &w[1].1);
        eprintln!("{} vs {}: max per-channel diff {d}", w[0].0, w[1].0);
        assert!(d <= TOL, "backends disagree by {d}");
    }
}

#[test]
fn opacity_zero_layer_leaves_black_and_full_opacity_is_srgb_exact() {
    let Some((c, _)) = headless_compositor(wgpu::Backends::all()) else {
        eprintln!("SKIPPED: no wgpu adapter");
        return;
    };
    let px = |o: f32| {
        let l = Layer {
            width: 2,
            height: 2,
            rgba: [200u8, 100, 50, 255].repeat(4),
            center: [2.0, 2.0],
            scale: [2.0, 2.0],
            rotation: 0.0,
            opacity: o,
        };
        c.render_to_rgba8(4, 4, &[l])[..4].to_vec()
    };
    assert_eq!(px(0.0), vec![0, 0, 0, 255]);
    let full = px(1.0);
    assert!(
        max_diff(&full, &[200, 100, 50, 255]) <= 1,
        "opaque layer must round-trip sRGB, got {full:?}"
    );
}
