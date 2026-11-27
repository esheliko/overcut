/**
 * The one compositor as the web UI and the exporter see it (M1-023): the Rust `app_render::Compositor` behind `crates/wasm` (`GpuRenderer`),
 * running in a Worker on an `OffscreenCanvas`. WebGPU when the browser has it, else WebGL2 (wgpu's GLES backend), chosen from the adapter.
 * Layer geometry is in sequence pixels and scales to the output size; the same call serves the preview (`present`) and export (`readback`).
 */

import type { Fit } from "./model.generated";
import type { TransformValues } from "./types";

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
  /** Crop of the upright picture: fractions removed from the left, top, right, bottom (on screen, after `flip`). Default none. `center`/`scale`/`angle` describe the whole uncropped picture. */
  crop?: [number, number, number, number];
  /** Mirror horizontally / vertically about the picture's centre. Default none. */
  flip?: [boolean, boolean];
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
  allocStats(): { textures: number; buffers: number; bind_groups: number; /** Uncaptured GPU errors so far (a rejected copy or draw): 0 in a healthy run. */ errors: number };
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
  const params = new Float64Array(13);
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
      const crop = l.crop;
      params[7] = crop ? crop[0] : 0;
      params[8] = crop ? crop[1] : 0;
      params[9] = crop ? crop[2] : 0;
      params[10] = crop ? crop[3] : 0;
      params[11] = l.flip?.[0] ? 1 : 0;
      params[12] = l.flip?.[1] ? 1 : 0;
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
    allocStats: () => JSON.parse(raw.alloc_stats()) as { textures: number; buffers: number; bind_groups: number; errors: number },
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

/** Size a `width` x `height` picture is drawn at on a `canvas` for `fit` (the size that `scale` 1 means), as a pair of scale factors. */
export function fitScale(fit: Fit, pic: { width: number; height: number }, canvas: { width: number; height: number }): [number, number] {
  if (!(pic.width > 0 && pic.height > 0 && canvas.width > 0 && canvas.height > 0)) return [1, 1];
  const kx = canvas.width / pic.width;
  const ky = canvas.height / pic.height;
  if (fit === "stretch") return [kx, ky];
  const k = fit === "cover" ? Math.max(kx, ky) : Math.min(kx, ky);
  return [k, k];
}

/**
 * The clip's transform (M2-003 `props`) -> compositor geometry (M2-024). Pure; units are sequence pixels, `display` is the picture's upright size.
 * Order: fit (contain/cover/stretch) -> scale -> the pivot (anchor) sits at canvas centre + position -> rotation about the pivot -> flip about the
 * picture centre -> crop of the source fractions (flip swaps which on-screen edge a source edge is).
 */
export function placeLayer(
  props: Pick<TransformValues, "position" | "scale" | "rotation" | "anchor" | "crop" | "flip" | "fit">,
  display: { width: number; height: number },
  canvas: { width: number; height: number },
): { center: [number, number]; scale: [number, number]; angle: number; crop: [number, number, number, number]; flip: [boolean, boolean] } {
  const [fx, fy] = fitScale(props.fit, display, canvas);
  const sx = fx * props.scale[0];
  const sy = fy * props.scale[1];
  const w = display.width * sx;
  const h = display.height * sy;
  const angle = (props.rotation * Math.PI) / 180;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  // Picture centre relative to the pivot, rotated clockwise (y down).
  const lx = -props.anchor[0] * w;
  const ly = -props.anchor[1] * h;
  const [ax, ay] = [canvas.width / 2 + props.position[0] * canvas.width, canvas.height / 2 + props.position[1] * canvas.height];
  const [l, t, r, b] = props.crop;
  const [fh, fv] = props.flip;
  return {
    center: [ax + lx * c - ly * s, ay + lx * s + ly * c],
    scale: [sx, sy],
    angle,
    crop: [fh ? r : l, fv ? b : t, fh ? l : r, fv ? t : b],
    flip: [fh, fv],
  };
}

/**
 * The engine's layer description (`evaluate`) plus the decoded picture -> the compositor's layer. The one mapping both the preview and the exporter use.
 * With `canvas` (the project's size) the clip's `props` are applied (fit, scale, anchor-pivoted rotation, flip, position, crop; see `placeLayer`); a
 * picture of another shape is fitted inside the canvas by default (a 16:9 clip on a 9:16 canvas is letterboxed). `pic.display` is the picture's real
 * upright size when `pic` itself is a smaller stand-in (a thumbnail). Without `canvas` the layer keeps the placement the engine gave.
 */
export function layerOf(
  l: { transform: { center: [number, number]; scale: [number, number]; rotation: number }; props?: TransformValues; opacity: number },
  pic: { source: LayerSource; width: number; height: number; rotation?: number; display?: { width: number; height: number } },
  canvas?: { width: number; height: number },
): GpuLayer {
  const rotation = pic.rotation ?? 0;
  if (canvas && l.props) {
    const turned = (((rotation % 180) + 180) % 180) === 90;
    const upright = { width: turned ? pic.height : pic.width, height: turned ? pic.width : pic.height };
    const display = pic.display ?? upright;
    const p = placeLayer(l.props, display, canvas);
    // `scale` multiplies the pixel size of the pixels we hand over, so a smaller stand-in grows to the real display size.
    const scale: [number, number] = [(p.scale[0] * display.width) / upright.width, (p.scale[1] * display.height) / upright.height];
    return { source: pic.source, width: pic.width, height: pic.height, rotation, center: p.center, scale, angle: p.angle, opacity: l.opacity, crop: p.crop, flip: p.flip };
  }
  const k = canvas ? containScale(pic, canvas) : 1;
  const scale: [number, number] = k === 1 ? l.transform.scale : [l.transform.scale[0] * k, l.transform.scale[1] * k];
  return { source: pic.source, width: pic.width, height: pic.height, rotation, center: l.transform.center, scale, angle: l.transform.rotation, opacity: l.opacity };
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
