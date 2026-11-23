//! Browser binding of the one GPU compositor (`app_render::Compositor`, ADR 0001/0003), M1-023. Thin: layer maths and colour live in `app-render`.
//!
//! Runs in a Worker on a transferred `OffscreenCanvas`. WebGPU is used when the browser has an adapter, else WebGL2 (wgpu's GLES backend); the
//! accumulation format is chosen from the adapter (`AccumFormat::for_adapter`). The preview presents into the canvas; export renders the same
//! frames and reads them back (or captures the canvas): both run the same shader pass, so pixels agree (tested).
//!
//! Per frame: `begin()`, then `add_rgba` / `add_external` per layer (bottom first; pixels go into persistent GPU slots right away), then `render`.

use app_render::{AccumFormat, Compositor, Layer, Pixels, OUTPUT_FORMAT};
use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[wasm_bindgen(inline_js = "
const ch = new MessageChannel();
const waiting = [];
ch.port1.onmessage = () => waiting.shift()();
export function macrotask() { return new Promise((res) => { waiting.push(res); ch.port2.postMessage(0); }); }
")]
extern "C" {
    /// A promise that resolves on a later turn of the event loop (promise callbacks and GPU completions get to run).
    fn macrotask() -> js_sys::Promise;
}

async fn yield_to_host() {
    let _ = wasm_bindgen_futures::JsFuture::from(macrotask()).await;
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Per-layer transform in sequence units; `params` order: centre x, centre y, scale x, scale y, rotation (radians clockwise), opacity, display rotation (degrees).
#[derive(Clone, Copy)]
struct Entry {
    w: u32,
    h: u32,
    p: [f32; 7],
}

#[wasm_bindgen]
pub struct GpuRenderer {
    /// Kept alive: Dawn drops pending map/copy completions when the instance is gone ("external Instance reference no longer exists").
    _instance: wgpu::Instance,
    surface: wgpu::Surface<'static>,
    canvas: web_sys::OffscreenCanvas,
    config: wgpu::SurfaceConfiguration,
    comp: Compositor,
    backend: &'static str,
    adapter_name: String,
    entries: Vec<Entry>,
    layer_buf: Vec<Layer<'static>>,
    readback: Vec<u8>,
}

async fn open(
    canvas: &web_sys::OffscreenCanvas,
    webgpu: bool,
) -> Result<
    (
        wgpu::Instance,
        wgpu::Surface<'static>,
        wgpu::Adapter,
        wgpu::Device,
        wgpu::Queue,
    ),
    String,
> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: if webgpu {
            wgpu::Backends::BROWSER_WEBGPU
        } else {
            wgpu::Backends::GL
        },
        ..Default::default()
    });
    // WebGPU: look for an adapter before touching the canvas (a canvas that got a "webgpu" context can never give a WebGL2 one afterwards).
    let probe = if webgpu {
        let a = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .map_err(err)?;
        Some(a)
    } else {
        None
    };
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(err)?;
    let adapter = match probe {
        Some(a) => a,
        None => instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .map_err(err)?,
    };
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("overcut"),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await
        .map_err(err)?;
    // Validation errors would otherwise abort the module (wgpu's default handler panics): report them to the console and carry on.
    device.on_uncaptured_error(Box::new(|e| {
        web_sys::console::error_1(&JsValue::from_str(&format!("wgpu: {e}")));
    }));
    Ok((instance, surface, adapter, device, queue))
}

#[wasm_bindgen]
impl GpuRenderer {
    /// `prefer`: `"auto"` (WebGPU, else WebGL2), `"webgpu"` or `"webgl2"`. Rejects with a plain message when neither can be set up.
    pub async fn create(
        canvas: web_sys::OffscreenCanvas,
        prefer: String,
    ) -> Result<GpuRenderer, String> {
        std::panic::set_hook(Box::new(|info| {
            web_sys::console::error_1(&JsValue::from_str(&format!("engine panic: {info}")));
        }));
        let mut last = String::from("no GPU backend was tried");
        let order: &[bool] = match prefer.as_str() {
            "webgpu" => &[true],
            "webgl2" => &[false],
            _ => &[true, false],
        };
        for &webgpu in order {
            // A failed WebGPU attempt may only have looked for an adapter (the canvas is untouched), so the WebGL2 attempt can still use it.
            match open(&canvas, webgpu).await {
                Ok((instance, surface, adapter, device, queue)) => {
                    let caps = surface.get_capabilities(&adapter);
                    if !caps.formats.contains(&OUTPUT_FORMAT) {
                        last = format!("the canvas cannot show {OUTPUT_FORMAT:?}");
                        continue;
                    }
                    let config = wgpu::SurfaceConfiguration {
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                        format: OUTPUT_FORMAT,
                        width: canvas.width().max(1),
                        height: canvas.height().max(1),
                        present_mode: wgpu::PresentMode::AutoVsync,
                        desired_maximum_frame_latency: 2,
                        alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                        view_formats: vec![],
                    };
                    surface.configure(&device, &config);
                    let accum = AccumFormat::for_adapter(&adapter);
                    return Ok(GpuRenderer {
                        _instance: instance,
                        surface,
                        canvas,
                        config,
                        comp: Compositor::new(device, queue, accum),
                        backend: if webgpu { "webgpu" } else { "webgl2" },
                        adapter_name: adapter.get_info().name,
                        entries: Vec::new(),
                        layer_buf: Vec::new(),
                        readback: Vec::new(),
                    });
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// JSON `{backend, accum, adapter}`.
    pub fn info(&self) -> String {
        format!(
            r#"{{"backend":"{}","accum":"{}","adapter":{}}}"#,
            self.backend,
            match self.comp.accum_format() {
                AccumFormat::Float16 => "float16",
                AccumFormat::Srgb8 => "srgb8",
            },
            serde_json::to_string(&self.adapter_name).unwrap_or_else(|_| "\"\"".into())
        )
    }

    /// JSON of the GPU objects created so far (steady state: unchanged between frames).
    pub fn alloc_stats(&self) -> String {
        let s = self.comp.alloc_stats();
        format!(
            r#"{{"textures":{},"buffers":{},"bind_groups":{}}}"#,
            s.textures, s.buffers, s.bind_groups
        )
    }

    /// Set the canvas (and surface) size in pixels. Cheap when unchanged.
    pub fn resize(&mut self, width: u32, height: u32) {
        let (w, h) = (width.max(1), height.max(1));
        if self.config.width == w && self.config.height == h {
            return;
        }
        self.canvas.set_width(w);
        self.canvas.set_height(h);
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(self.comp.device(), &self.config);
    }

    /// Start a frame: forget the previous layer list (the GPU slots stay).
    pub fn begin(&mut self) {
        self.entries.clear();
    }

    /// Next layer (bottom first) from RGBA bytes (sRGB, straight alpha), `w * h * 4` of them.
    pub fn add_rgba(&mut self, rgba: &[u8], w: u32, h: u32, params: &[f64]) -> Result<(), String> {
        let e = entry(w, h, params)?;
        if rgba.len() != (w as usize) * (h as usize) * 4 {
            return Err(format!(
                "RGBA layer is {} bytes, expected {}",
                rgba.len(),
                w * h * 4
            ));
        }
        self.comp.set_layer_rgba(self.entries.len(), w, h, rgba);
        self.entries.push(e);
        Ok(())
    }

    /// Next layer from a platform image: a WebCodecs `VideoFrame` (imported on the GPU, no CPU copy) or an `ImageBitmap`. (A canvas is not accepted: the WebGL2 backend cannot copy from one; read it with `getImageData` and use `add_rgba`.)
    /// `w` x `h` is the picture's display size; the caller still owns (and closes) the source.
    pub fn add_external(
        &mut self,
        source: JsValue,
        w: u32,
        h: u32,
        params: &[f64],
    ) -> Result<(), String> {
        let e = entry(w, h, params)?;
        let src = if let Some(f) = source.dyn_ref::<web_sys::VideoFrame>() {
            wgpu::ExternalImageSource::VideoFrame(Clone::clone(f))
        } else if let Some(b) = source.dyn_ref::<web_sys::ImageBitmap>() {
            wgpu::ExternalImageSource::ImageBitmap(b.clone())
        } else {
            return Err(
                "unsupported layer source (expected VideoFrame, ImageBitmap or OffscreenCanvas)"
                    .into(),
            );
        };
        let i = self.entries.len();
        let tex = self.comp.layer_texture(i, w, h).clone();
        self.comp.queue().copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: src,
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture: &tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.entries.push(e);
        Ok(())
    }

    /// Composite the layers added since `begin` at `out_w` x `out_h`. Layer geometry is in sequence pixels (`seq_w` x `seq_h`) and scales to the
    /// output. `present` draws into the canvas (preview); otherwise the frame stays in the internal target for `read_rgba8`.
    pub fn render(
        &mut self,
        seq_w: f64,
        seq_h: f64,
        out_w: u32,
        out_h: u32,
        present: bool,
    ) -> Result<(), String> {
        let layers = self.build(seq_w, seq_h, out_w);
        let _ = seq_h;
        let result = if present {
            self.resize(out_w, out_h);
            let frame = match self.surface.get_current_texture() {
                Ok(f) => f,
                Err(_) => {
                    self.surface.configure(self.comp.device(), &self.config);
                    self.surface.get_current_texture().map_err(err)?
                }
            };
            let view = frame.texture.create_view(&Default::default());
            self.comp.render_to_view(out_w, out_h, &layers, &view);
            frame.present();
            Ok(())
        } else {
            self.comp.render(out_w, out_h, &layers);
            Ok(())
        };
        self.layer_buf = recycle(layers);
        result
    }

    /// Composite offscreen and read the frame back as tightly packed RGBA8 (sRGB) into `dest` (a JS `Uint8Array` of `out_w * out_h * 4` bytes that
    /// the caller reuses every frame).
    pub async fn read_rgba8(
        &mut self,
        seq_w: f64,
        seq_h: f64,
        out_w: u32,
        out_h: u32,
        dest: Uint8Array,
    ) -> Result<(), String> {
        let layers = self.build(seq_w, seq_h, out_w);
        let mut out = std::mem::take(&mut self.readback);
        let r = self
            .comp
            .read_rgba8_into_with(out_w, out_h, &layers, &mut out, yield_to_host)
            .await;
        self.layer_buf = recycle(layers);
        self.readback = out;
        r.map_err(|_| "GPU readback failed".to_string())?;
        if dest.length() as usize != self.readback.len() {
            return Err(format!(
                "readback buffer is {} bytes, expected {}",
                dest.length(),
                self.readback.len()
            ));
        }
        dest.copy_from(&self.readback);
        Ok(())
    }
}

impl GpuRenderer {
    fn build(&mut self, seq_w: f64, _seq_h: f64, out_w: u32) -> Vec<Layer<'static>> {
        let k = if seq_w > 0.0 {
            out_w as f32 / seq_w as f32
        } else {
            1.0
        };
        let mut v = std::mem::take(&mut self.layer_buf);
        v.clear();
        for e in &self.entries {
            v.push(Layer {
                width: e.w,
                height: e.h,
                pixels: Pixels::Resident,
                center: [e.p[0] * k, e.p[1] * k],
                scale: [e.p[2] * k, e.p[3] * k],
                rotation: e.p[4],
                opacity: e.p[5],
                display_rotation: e.p[6].rem_euclid(360.0) as u16,
            });
        }
        v
    }
}

/// Keep the allocation of the per-frame layer list for the next frame.
fn recycle(mut v: Vec<Layer<'static>>) -> Vec<Layer<'static>> {
    v.clear();
    v
}

fn entry(w: u32, h: u32, p: &[f64]) -> Result<Entry, String> {
    if w == 0 || h == 0 {
        return Err("layer has no pixels".into());
    }
    if p.len() != 7 {
        return Err("layer params must be 7 numbers".into());
    }
    let mut a = [0f32; 7];
    for (d, s) in a.iter_mut().zip(p) {
        *d = *s as f32;
    }
    Ok(Entry { w, h, p: a })
}
