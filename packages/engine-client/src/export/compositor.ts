import type { VideoLayer } from "../types";
import type { DrawableFrame } from "./media";

/**
 * Draws a layer stack (bottom to top, transform + opacity from `evaluate`) over opaque black into one reused OffscreenCanvas, v0 on Canvas 2D.
 * Layer geometry is in sequence pixels; the output may be a different size (everything scales). The GPU compositor (`crates/render`) is not
 * reachable from the web build yet; it replaces this behind the same `draw` shape.
 */
export class CanvasCompositor {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly sx: number;
  private readonly sy: number;

  constructor(outW: number, outH: number, seqW: number, seqH: number) {
    this.canvas = new OffscreenCanvas(outW, outH);
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("OffscreenCanvas 2D is not available");
    ctx.imageSmoothingQuality = "high";
    this.ctx = ctx;
    this.sx = outW / seqW;
    this.sy = outH / seqH;
  }

  draw(layers: ReadonlyArray<{ layer: VideoLayer; frame: DrawableFrame }>): OffscreenCanvas {
    const { ctx } = this;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (const { layer, frame } of layers) {
      const t = layer.transform;
      ctx.save();
      ctx.globalAlpha = Math.min(1, Math.max(0, layer.opacity));
      ctx.translate(t.center[0] * this.sx, t.center[1] * this.sy);
      ctx.rotate(t.rotation);
      ctx.scale(t.scale[0] * this.sx, t.scale[1] * this.sy);
      if (frame.rotation) ctx.rotate((frame.rotation * Math.PI) / 180);
      ctx.drawImage(frame.source, -frame.width / 2, -frame.height / 2, frame.width, frame.height);
      ctx.restore();
    }
    return this.canvas;
  }
}
