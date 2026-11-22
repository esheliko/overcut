//! # app-render
//!
//! **Owns**: the GPU compositor on wgpu (WebGPU and WebGL2 in browsers, Vulkan/Metal/DX12 natively), the render graph built from an evaluated frame,
//! linear-light colour management (ADR 0003), preview presentation and export readback.
//!
//! **Rules**: one renderer for every platform; golden-frame tests per backend with a documented tolerance; no per-frame allocation in the hot path;
//! output must be deterministic for export.
//!
//! Status: spike S2 (`M1-020`). [`Compositor`] blends layers (2D transform + opacity) in linear light and encodes sRGB on output.
//! Known spike shortcuts (to fix in `M1-021`): layer textures and uniform buffers are created per frame.

use std::num::NonZeroU64;
use wgpu::util::DeviceExt;

/// Accumulation format: half-float linear light. Needs float-renderable support (core on WebGPU, `EXT_color_buffer_half_float` on WebGL2).
pub const ACCUM_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// Output format: sRGB-encoded 8-bit, written by the shader (not by the hardware) so all backends agree.
pub const OUTPUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// One image layer: straight-alpha sRGB RGBA8 pixels plus a 2D transform and opacity.
#[derive(Clone, Debug)]
pub struct Layer {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes, sRGB-encoded, straight alpha.
    pub rgba: Vec<u8>,
    /// Centre of the layer in output pixels.
    pub center: [f32; 2],
    /// Scale applied to the layer's pixel size.
    pub scale: [f32; 2],
    /// Rotation in radians, clockwise on screen.
    pub rotation: f32,
    /// 0..=1.
    pub opacity: f32,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerUniform {
    rect: [f32; 4],
    rot: [f32; 4],
    out_size: [f32; 4],
}

/// Layers in (bottom first), frame out.
pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    layer_bgl: wgpu::BindGroupLayout,
    layer_pipe: wgpu::RenderPipeline,
    present_bgl: wgpu::BindGroupLayout,
    present_pipe: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
}

impl Compositor {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("compositor"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let layer_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: NonZeroU64::new(
                            std::mem::size_of::<LayerUniform>() as u64
                        ),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
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
            ACCUM_FORMAT,
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
        Self {
            device,
            queue,
            layer_bgl,
            layer_pipe,
            present_bgl,
            present_pipe,
            sampler,
        }
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    /// Composite `layers` (bottom first) over opaque black into a new `OUTPUT_FORMAT` texture of `width` x `height`.
    pub fn render(&self, width: u32, height: u32, layers: &[Layer]) -> wgpu::Texture {
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let acc = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("accum"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: ACCUM_FORMAT,
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

        let groups: Vec<wgpu::BindGroup> = layers
            .iter()
            .map(|l| {
                let tex = self.device.create_texture_with_data(
                    &self.queue,
                    &wgpu::TextureDescriptor {
                        label: Some("layer"),
                        size: wgpu::Extent3d {
                            width: l.width,
                            height: l.height,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8UnormSrgb,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING,
                        view_formats: &[],
                    },
                    wgpu::util::TextureDataOrder::LayerMajor,
                    &l.rgba,
                );
                let (s, c) = l.rotation.sin_cos();
                let u = LayerUniform {
                    rect: [
                        l.center[0],
                        l.center[1],
                        l.width as f32 * l.scale[0] * 0.5,
                        l.height as f32 * l.scale[1] * 0.5,
                    ],
                    rot: [c, s, l.opacity.clamp(0.0, 1.0), 0.0],
                    out_size: [width as f32, height as f32, 0.0, 0.0],
                };
                let ub = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("layer uniform"),
                        contents: bytemuck::bytes_of(&u),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });
                self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("layer"),
                    layout: &self.layer_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: ub.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(
                                &tex.create_view(&Default::default()),
                            ),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                })
            })
            .collect();
        let present_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("present"),
            layout: &self.present_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&acc_view),
            }],
        });

        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("layers"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &acc_view,
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
            for g in &groups {
                pass.set_bind_group(0, g, &[]);
                pass.draw(0..6, 0..1);
            }
        }
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &out_view,
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
            pass.set_bind_group(0, &present_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([enc.finish()]);
        out
    }

    /// Render and read the frame back as tightly packed sRGB RGBA8 (`width * height * 4` bytes). Blocking: native only
    /// (browsers read back asynchronously through `map_async`; that path arrives with the web export work).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_to_rgba8(&self, width: u32, height: u32, layers: &[Layer]) -> Vec<u8> {
        let tex = self.render(width, height, layers);
        let bpr = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (bpr * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
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
        buf.slice(..)
            .map_async(wgpu::MapMode::Read, |r| r.expect("map readback"));
        self.device.poll(wgpu::PollType::Wait).expect("poll");
        let data = buf.slice(..).get_mapped_range();
        let mut out = Vec::with_capacity((width * height * 4) as usize);
        for row in data.chunks(bpr as usize).take(height as usize) {
            out.extend_from_slice(&row[..(width * 4) as usize]);
        }
        out
    }
}

/// Native helper: open a headless device on `backends`. `None` when no adapter exists (CI containers without a GPU or software driver).
#[cfg(not(target_arch = "wasm32"))]
pub fn headless_compositor(backends: wgpu::Backends) -> Option<(Compositor, wgpu::AdapterInfo)> {
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
    Some((Compositor::new(device, queue), info))
}
