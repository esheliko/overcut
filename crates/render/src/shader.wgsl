// Layer pass: one textured quad per layer, blended in linear light into the accumulation target.
// RGBA layers: tex is Rgba8UnormSrgb, so sampling already yields linear values.
// YUV layers (mode 1): tex = Y, tex_u / tex_v = chroma planes (R8Unorm, half resolution), decoded with the uniform matrix/range, then sRGB -> linear.
struct Layer {
    rect: vec4<f32>,     // centre.xy (output px), half size.xy (output px, after scale)
    rot: vec4<f32>,      // cos, sin, opacity, mode (0 = RGBA, 1 = YUV)
    out_size: vec4<f32>, // output w, h
    yuv_a: vec4<f32>,    // y_offset, y_scale, c_offset, c_scale
    yuv_b: vec4<f32>,    // r_cr, g_cb, g_cr, b_cb
    uv: vec4<f32>,       // row-major 2x2: displayed unit square (centred, y down) -> coded image (display rotation)
    crop: vec4<f32>,     // visible part of the displayed picture: left, top, right, bottom fractions removed
    flip: vec4<f32>,     // x, y: 1 = mirrored
};
@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tex_u: texture_2d<f32>;
@group(0) @binding(4) var tex_v: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs_layer(@builtin(vertex_index) i: u32) -> VOut {
    var c = array<vec2<f32>, 6>(
        vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
        vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
    let q = c[i];
    let local = (q * 2.0 - 1.0) * layer.rect.zw;
    let r = vec2(local.x * layer.rot.x - local.y * layer.rot.y, local.x * layer.rot.y + local.y * layer.rot.x);
    let p = r + layer.rect.xy;
    var o: VOut;
    o.pos = vec4(p.x / layer.out_size.x * 2.0 - 1.0, 1.0 - p.y / layer.out_size.y * 2.0, 0.0, 1.0);
    // quad corner -> position in the displayed picture (crop), mirrored (flip), centred
    var d = vec2(mix(layer.crop.x, 1.0 - layer.crop.z, q.x), mix(layer.crop.y, 1.0 - layer.crop.w, q.y));
    d = select(d, vec2(1.0) - d, layer.flip.xy > vec2(0.5));
    let qc = d - vec2(0.5);
    o.uv = vec2(layer.uv.x * qc.x + layer.uv.y * qc.y, layer.uv.z * qc.x + layer.uv.w * qc.y) + vec2(0.5);
    return o;
}

fn decode_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3(0.055)) / 1.055, vec3(2.4));
    return select(hi, lo, c <= vec3(0.04045));
}

fn shade(uv: vec2<f32>) -> vec4<f32> {
    // Sample everything unconditionally (uniform control flow); the mode only selects the result.
    let c = textureSample(tex, samp, uv);
    let cu = textureSample(tex_u, samp, uv).r;
    let cv = textureSample(tex_v, samp, uv).r;
    var rgb = c.rgb;
    var a = c.a;
    if (layer.rot.w > 0.5) {
        let y = (c.r - layer.yuv_a.x) * layer.yuv_a.y;
        let cb = (cu - layer.yuv_a.z) * layer.yuv_a.w;
        let cr = (cv - layer.yuv_a.z) * layer.yuv_a.w;
        let e = vec3(y + layer.yuv_b.x * cr, y - layer.yuv_b.y * cb - layer.yuv_b.z * cr, y + layer.yuv_b.w * cb);
        rgb = decode_srgb(clamp(e, vec3(0.0), vec3(1.0)));
        a = 1.0;
    }
    let o = a * layer.rot.z;
    return vec4(rgb * o, o); // premultiplied, linear
}

@fragment
fn fs_layer(v: VOut) -> @location(0) vec4<f32> {
    return shade(v.uv);
}

// Backdrop source (TL-19): the same layer, but each (small) target pixel averages a 10 x 10 grid of taps over the source area it covers (found from the uv
// derivatives, so it follows the display rotation too). A single bilinear sample of a 1080p picture into a tiny target aliases into stripes.
@fragment
fn fs_layer_prefilter(v: VOut) -> @location(0) vec4<f32> {
    let du = dpdx(v.uv);
    let dv = dpdy(v.uv);
    var acc = vec4(0.0);
    for (var j = 0; j < 10; j = j + 1) {
        for (var i = 0; i < 10; i = i + 1) {
            let o = (vec2(f32(i), f32(j)) + vec2(0.5)) / 10.0 - vec2(0.5);
            acc = acc + shade(v.uv + du * o.x + dv * o.y);
        }
    }
    return acc / 100.0;
}

// Present pass: accumulation (linear, premultiplied) -> sRGB-encoded Rgba8Unorm (explicit encode, so every backend does the same maths).
@group(0) @binding(0) var acc: texture_2d<f32>;

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4(p[i], 0.0, 1.0);
}

fn encode_srgb(l: vec3<f32>) -> vec3<f32> {
    let c = clamp(l, vec3(0.0), vec3(1.0));
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3(0.0031308));
}

@fragment
fn fs_present(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(acc, vec2<i32>(p.xy), 0); // premultiplied over opaque black
    return vec4(encode_srgb(c.rgb), 1.0);
}

// Background pass (TL-19): `fs_blur` is one direction of a separable 9-tap Gaussian over a small render target; `fs_copy` draws that target stretched over the
// whole canvas (bilinear). Both read `bgp`: dir = tap step in uv units (x or y), size = the target's size in pixels (uv = pixel / size).
struct BgParams { dir: vec2<f32>, size: vec2<f32> };
@group(0) @binding(0) var bg_tex: texture_2d<f32>;
@group(0) @binding(1) var bg_samp: sampler;
@group(0) @binding(2) var<uniform> bgp: BgParams;

@fragment
fn fs_blur(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = p.xy / bgp.size;
    // Gaussian sigma 2 taps (taps 0..4, spaced by the strength-dependent step), normalised.
    var w = array<f32, 5>(0.2042, 0.1802, 0.1238, 0.0663, 0.0276);
    var acc = textureSample(bg_tex, bg_samp, uv) * w[0];
    for (var i = 1; i < 5; i = i + 1) {
        let o = bgp.dir * f32(i);
        acc = acc + (textureSample(bg_tex, bg_samp, uv + o) + textureSample(bg_tex, bg_samp, uv - o)) * w[i];
    }
    return acc;
}

// Smooth (cubic B-spline, four bilinear fetches) enlargement of the small blurred target over the whole canvas: no tent/diamond artefacts of plain
// bilinear. Then dimmed a little so the sharp picture stands out, and dithered by one 8-bit code (in sRGB steps) so the smooth gradient does not band.
const BACKDROP_DIM: f32 = 0.7; // linear light (about 0.85 in sRGB terms)

fn cubic_weights(t: vec2<f32>) -> array<vec4<f32>, 2> {
    let t2 = t * t;
    let t3 = t2 * t;
    let w0 = (1.0 - t) * (1.0 - t) * (1.0 - t) / 6.0;
    let w1 = (3.0 * t3 - 6.0 * t2 + 4.0) / 6.0;
    let w2 = (-3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0) / 6.0;
    let w3 = t3 / 6.0;
    return array<vec4<f32>, 2>(vec4(w0.x, w1.x, w2.x, w3.x), vec4(w0.y, w1.y, w2.y, w3.y));
}

fn hash12(p: vec2<f32>) -> f32 {
    var q = fract(p * vec2(0.1031, 0.1030));
    q = q + dot(q, q.yx + vec2(33.33));
    return fract((q.x + q.y) * q.x);
}

@fragment
fn fs_copy(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(bg_tex));
    let x = (p.xy / bgp.size) * dims - vec2(0.5); // texel coordinates of the sample point (texel centres at integers)
    let ix = floor(x);
    let wt = cubic_weights(x - ix);
    let wx = wt[0];
    let wy = wt[1];
    let gx0 = wx.x + wx.y;
    let gx1 = wx.z + wx.w;
    let gy0 = wy.x + wy.y;
    let gy1 = wy.z + wy.w;
    let ox0 = (ix.x - 1.0 + wx.y / gx0 + 0.5) / dims.x;
    let ox1 = (ix.x + 1.0 + wx.w / gx1 + 0.5) / dims.x;
    let oy0 = (ix.y - 1.0 + wy.y / gy0 + 0.5) / dims.y;
    let oy1 = (ix.y + 1.0 + wy.w / gy1 + 0.5) / dims.y;
    let c = textureSample(bg_tex, bg_samp, vec2(ox0, oy0)) * gx0 * gy0
        + textureSample(bg_tex, bg_samp, vec2(ox1, oy0)) * gx1 * gy0
        + textureSample(bg_tex, bg_samp, vec2(ox0, oy1)) * gx0 * gy1
        + textureSample(bg_tex, bg_samp, vec2(ox1, oy1)) * gx1 * gy1;
    let l = max(c.rgb, vec3(0.0)) * BACKDROP_DIM;
    let n = (hash12(p.xy) - 0.5) / 255.0;
    // gamma 2 stands in for the sRGB curve here (cheap: sqrt and a square): the noise is one code, whatever the curve's exact slope
    let e = clamp(sqrt(l) + vec3(n), vec3(0.0), vec3(1.0));
    return vec4(e * e, 1.0);
}
