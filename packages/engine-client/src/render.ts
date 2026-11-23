/**
 * The one compositor as the web UI and the exporter see it (M1-023): the Rust `app_render::Compositor` behind `crates/wasm` (`GpuRenderer`),
 * running in a Worker on an `OffscreenCanvas`. WebGPU when the browser has it, else WebGL2 (wgpu's GLES backend), chosen from the adapter.
 * Layer geometry is in sequence pixels and scales to the output size; the same call serves the preview (`present`) and export (`readback`).
 */

/** Pixels of one layer: a decoded WebCodecs frame (imported on the GPU, no CPU copy), a bitmap, or RGBA bytes (sRGB, straight alpha; read a canvas with `getImageData`). */
export type LayerSource = VideoFrame | ImageBitmap | { rgba: Uint8Array };

export interface GpuLayer {
  source: LayerSource;
  /** Coded size of the pixels (before display rotation). */
  width: number;
  height: number;
  /** Display rotation of the media, clockwise degrees (the probe's `rotation`). */
  rotation: number;
  /** Layer centre in sequence pixels. */
  center: [number, number];
  /** Scale of the displayed (rotated) pixel size. */
  scale: [number, number];
  /** Transform rotation, radians clockwise. */
  angle: number;
  opacity: number;
}

export interface RendererInfo {
  backend: "webgpu" | "webgl2";
  /** How layers are accumulated: `float16` linear, or the `srgb8` fallback (docs/features/render.md). */
  accum: "float16" | "srgb8";
  adapter: string;
}

export interface GpuRenderer {
  readonly info: RendererInfo;
  /** Size of the canvas in pixels. */
  resize(width: number, height: number): void;
  /** Composite `layers` (bottom first, geometry in `seq` pixels) and present into the canvas at its current size. */
  present(layers: readonly GpuLayer[], seq: { width: number; height: number }): void;
  /** Composite offscreen at `out` and read the frame back as RGBA8 (sRGB, tight). The array is reused by the next call: copy it out (a `VideoFrame` does). */
  readback(layers: readonly GpuLayer[], seq: { width: number; height: number }, out: { width: number; height: number }): Promise<Uint8Array>;
  /** GPU objects created so far; unchanged between steady-state frames. */
  allocStats(): { textures: number; buffers: number; bind_groups: number };
  dispose(): void;
}

/** The generated `GpuRenderer` class (crates/wasm/src/render.rs). */
export interface RawGpuRenderer {
  info(): string;
  alloc_stats(): string;
  resize(w: number, h: number): void;
  begin(): void;
  add_rgba(rgba: Uint8Array, w: number, h: number, params: Float64Array): void;
  add_external(source: unknown, w: number, h: number, params: Float64Array): void;
  render(seqW: number, seqH: number, outW: number, outH: number, present: boolean): void;
  read_rgba8(seqW: number, seqH: number, outW: number, outH: number, dest: Uint8Array): Promise<void>;
  free(): void;
}

/** Wraps the generated class: packs layer parameters into one reused array and keeps the readback buffer. Pure glue, unit tested with a fake. */
export function wrapRenderer(raw: RawGpuRenderer, canvas: { width: number; height: number }): GpuRenderer {
  const info = JSON.parse(raw.info()) as RendererInfo;
  const params = new Float64Array(7);
  let buf = new Uint8Array(0);
  const add = (layers: readonly GpuLayer[]): void => {
    raw.begin();
    for (const l of layers) {
      params[0] = l.center[0];
      params[1] = l.center[1];
      params[2] = l.scale[0];
      params[3] = l.scale[1];
      params[4] = l.angle;
      params[5] = Math.min(1, Math.max(0, l.opacity));
      params[6] = l.rotation;
      if ("rgba" in l.source) raw.add_rgba(l.source.rgba, l.width, l.height, params);
      else raw.add_external(l.source, l.width, l.height, params);
    }
  };
  return {
    info,
    resize: (w, h) => {
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      raw.resize(canvas.width, canvas.height);
    },
    present(layers, seq) {
      add(layers);
      raw.render(seq.width, seq.height, canvas.width, canvas.height, true);
    },
    async readback(layers, seq, out) {
      add(layers);
      const n = out.width * out.height * 4;
      if (buf.length !== n) buf = new Uint8Array(n);
      await raw.read_rgba8(seq.width, seq.height, out.width, out.height, buf);
      return buf;
    },
    allocStats: () => JSON.parse(raw.alloc_stats()) as { textures: number; buffers: number; bind_groups: number },
    dispose: () => raw.free(),
  };
}

/**
 * How much to scale a picture of `width` x `height` (displayed, i.e. after any right-angle rotation) so it fits inside the canvas without cropping
 * ("contain": letterbox or pillarbox). 1 when the picture already has the canvas's size or shape; never enlarges beyond fitting the canvas.
 */
export function containScale(pic: { width: number; height: number; rotation?: number }, canvas: { width: number; height: number }): number {
  const turned = (((pic.rotation ?? 0) % 180) + 180) % 180 === 90;
  const w = turned ? pic.height : pic.width;
  const h = turned ? pic.width : pic.height;
  if (!(w > 0 && h > 0 && canvas.width > 0 && canvas.height > 0)) return 1;
  return Math.min(canvas.width / w, canvas.height / h);
}

/**
 * The engine's layer description (`evaluate`) plus the decoded picture -> the compositor's layer. The one mapping both the preview and the exporter use.
 * With `canvas` (the project's size) a picture of another size or shape is fitted inside it instead of drawn at its own pixel size (a 16:9 clip on a
 * 9:16 canvas is letterboxed, not cropped); without it the layer keeps the scale the engine gave.
 */
export function layerOf(
  l: { transform: { center: [number, number]; scale: [number, number]; rotation: number }; opacity: number },
  pic: { source: LayerSource; width: number; height: number; rotation?: number },
  canvas?: { width: number; height: number },
): GpuLayer {
  const k = canvas ? containScale(pic, canvas) : 1;
  const scale: [number, number] = k === 1 ? l.transform.scale : [l.transform.scale[0] * k, l.transform.scale[1] * k];
  return { source: pic.source, width: pic.width, height: pic.height, rotation: pic.rotation ?? 0, center: l.transform.center, scale, angle: l.transform.rotation, opacity: l.opacity };
}

/** Frames reach the encoder tagged as full-range sRGB, like a canvas capture. */
const SRGB_FRAME: VideoColorSpaceInit = { primaries: "bt709", transfer: "iec61966-2-1", matrix: "rgb", fullRange: true };

/**
 * One exported frame: composite offscreen at the output size and hand the encoder a `VideoFrame`. `readback` (GPU -> RGBA bytes -> VideoFrame) is
 * deterministic and does not depend on the canvas; `canvas` snapshots the presented canvas (no readback). Same shader pass either way.
 */
export async function renderExportFrame(
  renderer: GpuRenderer,
  canvas: OffscreenCanvas,
  mode: "readback" | "canvas",
  layers: readonly GpuLayer[],
  seq: { width: number; height: number },
  times: { timestamp: number; duration: number },
): Promise<VideoFrame> {
  if (mode === "canvas") {
    renderer.present(layers, seq);
    return new VideoFrame(canvas, times);
  }
  const out = { width: canvas.width, height: canvas.height };
  const px = await renderer.readback(layers, seq, out);
  return new VideoFrame(px, { format: "RGBA", codedWidth: out.width, codedHeight: out.height, colorSpace: SRGB_FRAME, ...times });
}
