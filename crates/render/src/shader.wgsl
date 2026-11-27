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

@fragment
fn fs_layer(v: VOut) -> @location(0) vec4<f32> {
    // Sample everything unconditionally (uniform control flow); the mode only selects the result.
    let c = textureSample(tex, samp, v.uv);
    let cu = textureSample(tex_u, samp, v.uv).r;
    let cv = textureSample(tex_v, samp, v.uv).r;
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
    // Gaussian sigma 2 (taps 0..4), normalised.
    var w = array<f32, 5>(0.2042, 0.1802, 0.1238, 0.0663, 0.0276);
    var acc = textureSample(bg_tex, bg_samp, uv) * w[0];
    for (var i = 1; i < 5; i = i + 1) {
        let o = bgp.dir * f32(i);
        acc = acc + (textureSample(bg_tex, bg_samp, uv + o) + textureSample(bg_tex, bg_samp, uv - o)) * w[i];
    }
    return acc;
}

@fragment
fn fs_copy(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureSample(bg_tex, bg_samp, p.xy / bgp.size);
    return vec4(c.rgb, 1.0);
}
