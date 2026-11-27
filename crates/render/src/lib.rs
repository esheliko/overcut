//! # app-render
//!
//! **Owns**: the GPU compositor on wgpu (WebGPU and WebGL2 in browsers, Vulkan/Metal/DX12 natively), the render graph built from an evaluated frame,
//! linear-light colour management (ADR 0003), preview presentation and export readback.
//!
//! **Rules**: one renderer for every platform; golden-frame tests per backend with a documented tolerance; no per-frame allocation in the hot path;
//! output must be deterministic for export.
//!
//! Status (`M1-021`): [`Compositor`] blends RGBA (sRGB) and YCbCr (BT.709/601, limited/full) layers in linear light and encodes sRGB on output.
//! Everything GPU-side is persistent: after warm-up a frame of unchanged size and layer count allocates no textures, buffers or bind groups
//! ([`Compositor::alloc_stats`] proves it). Readback is async (`map_async`) so it works in browsers. When the adapter cannot render to float
//! targets, the accumulation falls back to 8-bit sRGB ([`AccumFormat::Srgb8`]); see `docs/features/render.md`.

mod colour;

pub use colour::{
    linear_to_srgb, rgb_to_yuv, srgb_to_linear, yuv_params, yuv_to_rgb, YuvMatrix, YuvRange,
};

use std::future::Future;
use std::num::NonZeroU64;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

/// Output format: sRGB-encoded 8-bit, written by the shader (not by the hardware) so all backends agree.
pub const OUTPUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// How layers are accumulated before the sRGB encode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccumFormat {
    /// `Rgba16Float` linear light. Best quality; needs float-renderable + blendable support (core on WebGPU and desktop, `EXT_color_buffer_half_float`/`float` on WebGL2).
    Float16,
    /// `Rgba8UnormSrgb`: the hardware decodes on blend and encodes on write, so blending is still linear but every layer rounds to 8-bit sRGB
    /// (about +-0.5 code value per layer, slightly more banding in dark gradients, values above 1.0 clip). Works everywhere.
    Srgb8,
}

impl AccumFormat {
    pub fn texture_format(self) -> wgpu::TextureFormat {
        match self {
            AccumFormat::Float16 => wgpu::TextureFormat::Rgba16Float,
            AccumFormat::Srgb8 => wgpu::TextureFormat::Rgba8UnormSrgb,
        }
    }

    /// Pick the best accumulation format the adapter can render and blend into (runtime capability check).
    pub fn for_adapter(adapter: &wgpu::Adapter) -> Self {
        let f = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba16Float);
        let ok = f.allowed_usages.contains(
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        ) && f.flags.contains(wgpu::TextureFormatFeatureFlags::BLENDABLE);
        if ok {
            AccumFormat::Float16
        } else {
            AccumFormat::Srgb8
        }
    }
}

/// Pixel data of one layer, borrowed from the caller (no copy until it is uploaded).
#[derive(Clone, Copy, Debug)]
pub enum Pixels<'a> {
    /// `width * height * 4` bytes, sRGB-encoded, straight alpha.
    Rgba8Srgb(&'a [u8]),
    /// Planar 4:2:0 video frame: `y` is `width * height`, `u` and `v` are `ceil(w/2) * ceil(h/2)`, tightly packed.
    Yuv420 {
        y: &'a [u8],
        u: &'a [u8],
        v: &'a [u8],
        range: YuvRange,
        matrix: YuvMatrix,
    },
    /// The slot already holds this layer's RGBA pixels: they were written with [`Compositor::set_layer_rgba`] or copied in from the platform
    /// (`copy_external_image_to_texture` on [`Compositor::layer_texture`], e.g. a WebCodecs `VideoFrame`). Nothing is uploaded at render time.
    Resident,
}

/// One layer: pixels plus a 2D transform and opacity.
#[derive(Clone, Copy, Debug)]
pub struct Layer<'a> {
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels<'a>,
    /// Centre of the layer in output pixels.
    pub center: [f32; 2],
    /// Scale applied to the layer's pixel size.
    pub scale: [f32; 2],
    /// Rotation in radians, clockwise on screen.
    pub rotation: f32,
    /// 0..=1.
    pub opacity: f32,
    /// Display rotation of the media in degrees clockwise (0, 90, 180, 270; other values round to the nearest right angle). At 90/270 the layer's
    /// displayed width and height swap, so `scale` applies to the upright picture and the layer is upright without a `rotation` of its own.
    pub display_rotation: u16,
    /// Crop of the upright picture as fractions removed from the left, top, right, bottom edge (`0 <= v < 1`, opposite edges sum below 1; M2-024).
    /// `center`, `scale` and `rotation` still describe the whole uncropped picture, so cropping never moves the visible part.
    pub crop: [f32; 4],
    /// Mirror the (cropped) picture horizontally / vertically about its own centre. The crop is given on screen, after the mirror.
    pub flip: [bool; 2],
}

/// Where the visible part of a layer lands: its centre and half size in output pixels (before `rotation` about the centre), from the whole
/// picture's `center`, displayed size `dw` x `dh`, `scale` and `crop`. Pure, so it is unit tested without a GPU.
pub fn visible_rect(
    center: [f32; 2],
    dw: f32,
    dh: f32,
    scale: [f32; 2],
    rotation: f32,
    crop: [f32; 4],
) -> ([f32; 2], [f32; 2]) {
    let [l, t, r, b] = crop.map(|v| v.clamp(0.0, 0.999));
    let (w, h) = (dw * scale[0], dh * scale[1]);
    let (ox, oy) = ((l - r) * 0.5 * w, (t - b) * 0.5 * h);
    let (s, c) = rotation.sin_cos();
    (
        [center[0] + ox * c - oy * s, center[1] + ox * s + oy * c],
        [
            w * (1.0 - l - r).max(0.001) * 0.5,
            h * (1.0 - t - b).max(0.001) * 0.5,
        ],
    )
}

/// What to copy from a platform image (`copy_external_image_to_texture`) into a layer texture of `layer` (w, h): the part both have.
/// The copy is validated against the SOURCE's own size, so a copy sized by the layer overruns a source that is smaller (a different clip's
/// frame, a thumbnail) or already closed (size 0) and the whole call is rejected. `None` when there is nothing to copy (closed or empty source):
/// the slot keeps its last picture instead of the GPU reporting a validation error.
pub fn external_copy_extent(layer: (u32, u32), source: (u32, u32)) -> Option<(u32, u32)> {
    let (w, h) = (layer.0.min(source.0), layer.1.min(source.1));
    (w > 0 && h > 0).then_some((w, h))
}

/// Rotation as the row-major matrix `[a, b, c, d]` taking a point of the displayed unit square (centred, y down) to the coded image (centred).
/// Exact for right angles. A phone clip whose probe says 90 is stored sideways; showing it rotated clockwise by 90 makes it upright.
pub fn texture_matrix(display_rotation: u16) -> [f32; 4] {
    match (((display_rotation as u32 + 45) / 90) % 4) as u8 {
        1 => [0.0, 1.0, -1.0, 0.0],
        2 => [-1.0, 0.0, 0.0, -1.0],
        3 => [0.0, -1.0, 1.0, 0.0],
        _ => [1.0, 0.0, 0.0, 1.0],
    }
}

fn swaps_axes(display_rotation: u16) -> bool {
    matches!(((display_rotation as u32 + 45) / 90) % 4, 1 | 3)
}

/// Counts of GPU objects created by a [`Compositor`]. A steady-state frame must not change any of them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AllocStats {
    pub textures: u64,
    pub buffers: u64,
    pub bind_groups: u64,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerUniform {
    rect: [f32; 4],
    rot: [f32; 4],
    out_size: [f32; 4],
    yuv_a: [f32; 4],
    yuv_b: [f32; 4],
    /// Row-major 2x2 `texture_matrix` (display unit square -> coded image).
    uv: [f32; 4],
    /// Crop in display space (left, top, right, bottom fractions); the quad covers only the visible part.
    crop: [f32; 4],
    /// Mirror flags in x and y (1 = mirrored).
    flip: [f32; 4],
}
const UNIFORM_SIZE: u64 = std::mem::size_of::<LayerUniform>() as u64;

struct Target {
    w: u32,
    h: u32,
    _acc: wgpu::Texture,
    acc_view: wgpu::TextureView,
    out: wgpu::Texture,
    out_view: wgpu::TextureView,
    present_group: wgpu::BindGroup,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    Rgba,
    Yuv,
}

/// Persistent GPU state for layer `i`: textures, views and a bind group, rebuilt only when size/kind changes.
struct Slot {
    kind: Kind,
    w: u32,
    h: u32,
    textures: Vec<wgpu::Texture>,
    views: Vec<wgpu::TextureView>,
    group: Option<wgpu::BindGroup>,
    group_gen: u64,
}

/// Layers in (bottom first), frame out.
pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    accum: AccumFormat,
    layer_bgl: wgpu::BindGroupLayout,
    layer_pipe: wgpu::RenderPipeline,
    present_bgl: wgpu::BindGroupLayout,
    present_pipe: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    _dummy_tex: wgpu::Texture,
    dummy_view: wgpu::TextureView,
    target: Option<Target>,
    slots: Vec<Slot>,
    ubuf: wgpu::Buffer,
    ubuf_cap: usize,
    ubuf_gen: u64,
    stride: usize,
    scratch: Vec<u8>,
    readback: Option<(wgpu::Buffer, u64)>,
    stats: AllocStats,
}

impl Compositor {
    /// `accum` normally comes from [`AccumFormat::for_adapter`].
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, accum: AccumFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layer_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: NonZeroU64::new(UNIFORM_SIZE),
                    },
                    count: None,
                },
                tex_entry(1),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                tex_entry(3),
                tex_entry(4),
            ],
        });
        let present_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("present"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let premul = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let mk = |label, bgl: &wgpu::BindGroupLayout, vs, fs, format, blend| {
            let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[bgl],
                push_constant_ranges: &[],
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vs),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let layer_pipe = mk(
            "layer",
            &layer_bgl,
            "vs_layer",
            "fs_layer",
            accum.texture_format(),
            Some(premul),
        );
        let present_pipe = mk(
            "present",
            &present_bgl,
            "vs_full",
            "fs_present",
            OUTPUT_FORMAT,
            None,
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let dummy_tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("dummy plane"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let dummy_view = dummy_tex.create_view(&Default::default());
        let stride = (device.limits().min_uniform_buffer_offset_alignment as usize)
            .max(UNIFORM_SIZE as usize)
            .next_multiple_of(device.limits().min_uniform_buffer_offset_alignment as usize);
        let ubuf_cap = 8;
        let ubuf = Self::make_ubuf(&device, ubuf_cap * stride);
        Self {
            device,
            queue,
            accum,
            layer_bgl,
            layer_pipe,
            present_bgl,
            present_pipe,
            sampler,
            _dummy_tex: dummy_tex,
            dummy_view,
            target: None,
            slots: Vec::new(),
            ubuf,
            ubuf_cap,
            ubuf_gen: 0,
            stride,
            scratch: Vec::new(),
            readback: None,
            stats: AllocStats {
                textures: 1,
                buffers: 1,
                bind_groups: 0,
            },
        }
    }

    fn make_ubuf(device: &wgpu::Device, size: usize) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("layer uniforms"),
            size: size as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn accum_format(&self) -> AccumFormat {
        self.accum
    }

    /// GPU objects created so far. Equal before and after a steady-state frame (same output size, same layer sizes and kinds).
    pub fn alloc_stats(&self) -> AllocStats {
        self.stats
    }

    fn ensure_target(&mut self, w: u32, h: u32) {
        if self.target.as_ref().is_some_and(|t| t.w == w && t.h == h) {
            return;
        }
        let size = wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        };
        let acc = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("accum"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.accum.texture_format(),
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let out = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("output"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OUTPUT_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let acc_view = acc.create_view(&Default::default());
        let out_view = out.create_view(&Default::default());
        let present_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("present"),
            layout: &self.present_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&acc_view),
            }],
        });
        self.stats.textures += 2;
        self.stats.bind_groups += 1;
        self.target = Some(Target {
            w,
            h,
            _acc: acc,
            acc_view,
            out,
            out_view,
            present_group,
        });
    }

    fn ensure_uniforms(&mut self, layers: usize) {
        if layers <= self.ubuf_cap {
            return;
        }
        self.ubuf_cap = layers.next_power_of_two();
        self.ubuf = Self::make_ubuf(&self.device, self.ubuf_cap * self.stride);
        self.ubuf_gen += 1; // every cached bind group points at the old buffer
        self.stats.buffers += 1;
    }

    /// Make slot `i` match layer `l` (re-creating textures only when kind or size changed), upload its pixels, and (re)build its bind group if stale.
    fn prepare_slot(&mut self, i: usize, l: &Layer) {
        let kind = match l.pixels {
            Pixels::Rgba8Srgb(_) | Pixels::Resident => Kind::Rgba,
            Pixels::Yuv420 { .. } => Kind::Yuv,
        };
        if self.slots.len() <= i {
            self.slots.push(Slot {
                kind,
                w: 0,
                h: 0,
                textures: vec![],
                views: vec![],
                group: None,
                group_gen: 0,
            });
        }
        let slot = &mut self.slots[i];
        if slot.textures.is_empty() || slot.kind != kind || slot.w != l.width || slot.h != l.height
        {
            let dims: Vec<(u32, u32, wgpu::TextureFormat)> = match kind {
                Kind::Rgba => vec![(l.width, l.height, wgpu::TextureFormat::Rgba8UnormSrgb)],
                Kind::Yuv => {
                    let (cw, ch) = (l.width.div_ceil(2), l.height.div_ceil(2));
                    vec![
                        (l.width, l.height, wgpu::TextureFormat::R8Unorm),
                        (cw, ch, wgpu::TextureFormat::R8Unorm),
                        (cw, ch, wgpu::TextureFormat::R8Unorm),
                    ]
                }
            };
            slot.textures.clear();
            slot.views.clear();
            for (w, h, format) in dims {
                let t = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("layer plane"),
                    size: wgpu::Extent3d {
                        width: w,
                        height: h,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    // RENDER_ATTACHMENT: `copy_external_image_to_texture` (VideoFrame import) needs it on the destination.
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::RENDER_ATTACHMENT,
                    view_formats: &[],
                });
                slot.views.push(t.create_view(&Default::default()));
                slot.textures.push(t);
                self.stats.textures += 1;
            }
            slot.kind = kind;
            slot.w = l.width;
            slot.h = l.height;
            slot.group = None;
        }
        let up = |tex: &wgpu::Texture, data: &[u8], w: u32, h: u32, bpp: u32| {
            assert_eq!(
                data.len(),
                (w * h * bpp) as usize,
                "layer plane has the wrong byte length for {w}x{h}"
            );
            self.queue.write_texture(
                tex.as_image_copy(),
                data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(w * bpp),
                    rows_per_image: Some(h),
                },
                wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
        };
        match l.pixels {
            Pixels::Rgba8Srgb(d) => up(&slot.textures[0], d, l.width, l.height, 4),
            Pixels::Resident => {}
            Pixels::Yuv420 { y, u, v, .. } => {
                let (cw, ch) = (l.width.div_ceil(2), l.height.div_ceil(2));
                up(&slot.textures[0], y, l.width, l.height, 1);
                up(&slot.textures[1], u, cw, ch, 1);
                up(&slot.textures[2], v, cw, ch, 1);
            }
        }
        if slot.group.is_none() || slot.group_gen != self.ubuf_gen {
            let (v1, v2) = match kind {
                Kind::Rgba => (&self.dummy_view, &self.dummy_view),
                Kind::Yuv => (&slot.views[1], &slot.views[2]),
            };
            slot.group = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("layer"),
                layout: &self.layer_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &self.ubuf,
                            offset: 0,
                            size: NonZeroU64::new(UNIFORM_SIZE),
                        }),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&slot.views[0]),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(v1),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::TextureView(v2),
                    },
                ],
            }));
            slot.group_gen = self.ubuf_gen;
            self.stats.bind_groups += 1;
        }
    }

    /// Composite `layers` (bottom first) over opaque black into the persistent `OUTPUT_FORMAT` texture of `width` x `height`.
    /// The returned texture is overwritten by the next call.
    pub fn render(&mut self, width: u32, height: u32, layers: &[Layer]) -> &wgpu::Texture {
        self.render_inner(width, height, layers, None);
        &self.target.as_ref().expect("target").out
    }

    /// Like [`Compositor::render`], but the final sRGB-encoded pass writes straight into `view` (a canvas surface texture) instead of the internal
    /// output texture. `view` must be `width` x `height` and [`OUTPUT_FORMAT`]. It is the same shader pass over the same accumulation, so the
    /// pixels equal what `render` + readback produce (the preview/export parity guarantee, tested).
    pub fn render_to_view(
        &mut self,
        width: u32,
        height: u32,
        layers: &[Layer],
        view: &wgpu::TextureView,
    ) {
        self.render_inner(width, height, layers, Some(view));
    }

    /// Make slot `i` an RGBA slot of `width` x `height` and return its texture, for the platform to copy pixels into
    /// (`Queue::copy_external_image_to_texture`). Pair with [`Pixels::Resident`]. Allocates only when the slot is new or its size changed.
    pub fn layer_texture(&mut self, i: usize, width: u32, height: u32) -> &wgpu::Texture {
        self.ensure_rgba_slot(i, width, height);
        &self.slots[i].textures[0]
    }

    /// Upload RGBA pixels (sRGB, straight alpha, `width * height * 4` bytes) into slot `i` now. Pair with [`Pixels::Resident`].
    pub fn set_layer_rgba(&mut self, i: usize, width: u32, height: u32, data: &[u8]) {
        assert_eq!(
            data.len(),
            (width * height * 4) as usize,
            "wrong RGBA length"
        );
        self.ensure_rgba_slot(i, width, height);
        self.queue.write_texture(
            self.slots[i].textures[0].as_image_copy(),
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    fn ensure_rgba_slot(&mut self, i: usize, width: u32, height: u32) {
        let l = Layer {
            width,
            height,
            pixels: Pixels::Resident,
            center: [0.0; 2],
            scale: [1.0; 2],
            rotation: 0.0,
            opacity: 1.0,
            display_rotation: 0,
            crop: [0.0; 4],
            flip: [false; 2],
        };
        self.prepare_slot(i, &l);
    }

    fn render_inner(
        &mut self,
        width: u32,
        height: u32,
        layers: &[Layer],
        view: Option<&wgpu::TextureView>,
    ) {
        self.ensure_target(width, height);
        self.ensure_uniforms(layers.len());
        self.scratch.clear();
        self.scratch.resize(layers.len() * self.stride, 0);
        for (i, l) in layers.iter().enumerate() {
            self.prepare_slot(i, l);
            let (s, c) = l.rotation.sin_cos();
            let (mode, a, b) = match l.pixels {
                Pixels::Rgba8Srgb(_) | Pixels::Resident => (0.0, [0.0; 4], [0.0; 4]),
                Pixels::Yuv420 { range, matrix, .. } => {
                    let (a, b) = yuv_params(range, matrix);
                    (1.0, a, b)
                }
            };
            let (dw, dh) = if swaps_axes(l.display_rotation) {
                (l.height, l.width)
            } else {
                (l.width, l.height)
            };
            let crop = l.crop.map(|v| v.clamp(0.0, 0.999));
            let (centre, half) =
                visible_rect(l.center, dw as f32, dh as f32, l.scale, l.rotation, crop);
            let u = LayerUniform {
                rect: [centre[0], centre[1], half[0], half[1]],
                rot: [c, s, l.opacity.clamp(0.0, 1.0), mode],
                out_size: [width as f32, height as f32, 0.0, 0.0],
                yuv_a: a,
                yuv_b: b,
                uv: texture_matrix(l.display_rotation),
                crop,
                flip: [l.flip[0] as u8 as f32, l.flip[1] as u8 as f32, 0.0, 0.0],
            };
            self.scratch[i * self.stride..i * self.stride + UNIFORM_SIZE as usize]
                .copy_from_slice(bytemuck::bytes_of(&u));
        }
        if !layers.is_empty() {
            self.queue.write_buffer(&self.ubuf, 0, &self.scratch);
        }

        let t = self.target.as_ref().expect("target");
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("layers"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &t.acc_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.layer_pipe);
            for (i, slot) in self.slots.iter().take(layers.len()).enumerate() {
                pass.set_bind_group(
                    0,
                    slot.group.as_ref().expect("bind group"),
                    &[(i * self.stride) as u32],
                );
                pass.draw(0..6, 0..1);
            }
        }
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: view.unwrap_or(&t.out_view),
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.present_pipe);
            pass.set_bind_group(0, &t.present_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([enc.finish()]);
    }

    /// Render and read the frame back as tightly packed sRGB RGBA8 into `out` (`width * height * 4` bytes; `out` is cleared and reused, so a
    /// steady-state export loop allocates nothing). Async because browsers cannot block on the GPU: it uses `map_async`, which on the web
    /// resolves from the event loop. On native it completes on first poll. Do not run two readbacks at once (it takes `&mut self`) and do not
    /// drop the future after it started; await it to completion.
    pub async fn read_rgba8_into(
        &mut self,
        width: u32,
        height: u32,
        layers: &[Layer<'_>],
        out: &mut Vec<u8>,
    ) -> Result<(), wgpu::BufferAsyncError> {
        self.read_rgba8_into_with(width, height, layers, out, || std::future::ready(()))
            .await
    }

    /// [`Compositor::read_rgba8_into`] with a hook that gives the host event loop a turn while the map is pending (`yield_to_host`: in the browser a
    /// `MessageChannel` round trip; WebGL2 only completes the map when the device is polled again). Required on the web, where the plain version would spin.
    pub async fn read_rgba8_into_with<Y: Future<Output = ()>>(
        &mut self,
        width: u32,
        height: u32,
        layers: &[Layer<'_>],
        out: &mut Vec<u8>,
        mut yield_to_host: impl FnMut() -> Y,
    ) -> Result<(), wgpu::BufferAsyncError> {
        self.render(width, height, layers);
        let bpr = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let need = (bpr * height) as u64;
        if self.readback.as_ref().is_none_or(|(_, cap)| *cap < need) {
            self.readback = Some((
                self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("readback"),
                    size: need,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }),
                need,
            ));
            self.stats.buffers += 1;
        }
        let buf = self.readback.as_ref().expect("readback").0.clone();
        let tex = &self.target.as_ref().expect("target").out;
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bpr),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([enc.finish()]);
        let done = Arc::new(AtomicU8::new(0)); // 0 pending, 1 mapped, 2 failed
        let cb = done.clone();
        buf.slice(..need).map_async(wgpu::MapMode::Read, move |r| {
            cb.store(if r.is_ok() { 1 } else { 2 }, Ordering::Release);
        });
        // Native: block on the device. Web: the WebGPU backend fires the callback from a promise, the WebGL2 backend only when the device is polled,
        // so poll and give the host a turn of its event loop between polls.
        loop {
            #[cfg(not(target_arch = "wasm32"))]
            let _ = self.device.poll(wgpu::PollType::Wait);
            #[cfg(target_arch = "wasm32")]
            let _ = self.device.poll(wgpu::PollType::Poll);
            match done.load(Ordering::Acquire) {
                1 => break,
                2 => return Err(wgpu::BufferAsyncError),
                _ => yield_to_host().await,
            }
        }
        {
            let data = buf.slice(..need).get_mapped_range();
            out.clear();
            let row = (width * 4) as usize;
            for r in data.chunks(bpr as usize).take(height as usize) {
                out.extend_from_slice(&r[..row]);
            }
        }
        buf.unmap();
        Ok(())
    }

    /// Blocking readback for native callers and tests.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_to_rgba8(&mut self, width: u32, height: u32, layers: &[Layer]) -> Vec<u8> {
        let mut out = Vec::new();
        pollster::block_on(self.read_rgba8_into(width, height, layers, &mut out))
            .expect("map readback");
        out
    }
}

/// One process-wide GPU per backend set: the instance, adapter, device and queue are created on first use and never dropped.
/// Why: tearing a wgpu instance/device down while other threads (parallel tests) create or use theirs races inside Mesa's llvmpipe/lavapipe and EGL
/// (shared display, rasteriser thread pool) and crashed CI with SIGSEGV; one long-lived device has no such lifecycle.
#[cfg(not(target_arch = "wasm32"))]
struct SharedGpu {
    _instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    info: wgpu::AdapterInfo,
}

#[cfg(not(target_arch = "wasm32"))]
fn shared_gpu(backends: wgpu::Backends) -> Option<&'static SharedGpu> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    type Cache = Mutex<HashMap<u32, Option<&'static SharedGpu>>>;
    static GPUS: OnceLock<Cache> = OnceLock::new();
    let mut map = GPUS.get_or_init(Default::default).lock().unwrap();
    *map.entry(backends.bits()).or_insert_with(|| {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends,
            ..Default::default()
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .ok()?;
        let info = adapter.get_info();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("overcut headless"),
            required_limits:
                wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
            ..Default::default()
        }))
        .ok()?;
        // Leaked on purpose: lives (and is never torn down) for the whole process.
        Some(&*Box::leak(Box::new(SharedGpu {
            _instance: instance,
            adapter,
            device,
            queue,
            info,
        })))
    })
}

/// Native helper: a [`Compositor`] on the process-wide headless device for `backends`, choosing the accumulation format from the adapter
/// (or `force_accum`). Compositors made here share one device (see [`SharedGpu`]); each owns its own textures and buffers.
/// `None` when no adapter exists (CI containers without a GPU or software driver).
#[cfg(not(target_arch = "wasm32"))]
pub fn headless_compositor_with(
    backends: wgpu::Backends,
    force_accum: Option<AccumFormat>,
) -> Option<(Compositor, wgpu::AdapterInfo)> {
    let g = shared_gpu(backends)?;
    let accum = force_accum.unwrap_or_else(|| AccumFormat::for_adapter(&g.adapter));
    Some((
        Compositor::new(g.device.clone(), g.queue.clone(), accum),
        g.info.clone(),
    ))
}

/// [`headless_compositor_with`] with runtime format selection.
#[cfg(not(target_arch = "wasm32"))]
pub fn headless_compositor(backends: wgpu::Backends) -> Option<(Compositor, wgpu::AdapterInfo)> {
    headless_compositor_with(backends, None)
}

#[cfg(test)]
mod tests {
    #[test]
    fn external_copy_never_exceeds_the_source() {
        use super::external_copy_extent as ext;
        assert_eq!(ext((160, 120), (160, 120)), Some((160, 120)));
        assert_eq!(
            ext((160, 120), (320, 180)),
            Some((160, 120)),
            "a bigger source is cropped, never overrun"
        );
        assert_eq!(
            ext((320, 180), (160, 120)),
            Some((160, 120)),
            "a smaller source is copied whole"
        );
        assert_eq!(
            ext((160, 120), (0, 0)),
            None,
            "a closed frame reports size 0"
        );
        assert_eq!(ext((0, 120), (160, 120)), None);
    }

    use super::visible_rect;

    #[test]
    fn visible_rect_is_the_whole_picture_without_a_crop() {
        let (c, h) = visible_rect([100.0, 50.0], 40.0, 20.0, [2.0, 2.0], 0.7, [0.0; 4]);
        assert_eq!(c, [100.0, 50.0]);
        assert_eq!(h, [40.0, 20.0]);
    }

    #[test]
    fn crop_shrinks_the_rect_and_shifts_its_centre_along_the_rotated_axes() {
        // Remove the left half of an 80 x 20 picture: 40 wide, centred 20 px right of the picture centre.
        let (c, h) = visible_rect(
            [0.0, 0.0],
            40.0,
            10.0,
            [2.0, 2.0],
            0.0,
            [0.5, 0.0, 0.0, 0.0],
        );
        assert_eq!((c, h), ([20.0, 0.0], [20.0, 10.0]));
        // Rotated a quarter turn clockwise, "right" points down the screen.
        let (c, _) = visible_rect(
            [0.0, 0.0],
            40.0,
            10.0,
            [2.0, 2.0],
            std::f32::consts::FRAC_PI_2,
            [0.5, 0.0, 0.0, 0.0],
        );
        assert!(c[0].abs() < 1e-4 && (c[1] - 20.0).abs() < 1e-4, "{c:?}");
    }
}
