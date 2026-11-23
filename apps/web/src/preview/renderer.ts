/** What the player needs from the compositor: the engine's Rust GPU compositor (`@app/engine-client` `GpuRenderer`) in the preview Worker. */
import type { GpuLayer } from "@app/engine-client";

export type RenderLayer = GpuLayer;

export interface Renderer {
  /** Draw the layers into the canvas; `seq` is the sequence size the layer coordinates are in. */
  render(layers: readonly RenderLayer[], seq: { width: number; height: number }): void;
  dispose(): void;
}
