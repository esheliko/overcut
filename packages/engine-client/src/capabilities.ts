/** Mirrors `app_core::Capabilities` (crates/core/src/capabilities.rs). Field names are the Rust (snake_case) ones. */
export type Support = "hardware" | "supported" | "no" | "unknown";

export interface CodecSupport {
  codec: string;
  tested: string;
  decode: Support;
  encode: Support;
}

export interface GpuAdapter {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  fallback: boolean;
}

export interface Capabilities {
  host: "web" | "tauri";
  platform: {
    user_agent: string;
    platform: string;
    os: string | null;
    arch: string | null;
    hardware_concurrency: number | null;
    device_memory_gb: number | null;
  };
  codecs: CodecSupport[];
  webgpu: { available: boolean; adapter: GpuAdapter | null; limits: Record<string, number>; features: string[]; error: string | null };
  webgl2: { available: boolean; renderer: string | null; max_texture_size: number | null };
  shared_array_buffer: boolean;
  cross_origin_isolated: boolean;
  opfs: boolean;
  web_workers: boolean;
  offscreen_canvas: boolean;
  /** Plain-language gaps, written by the engine. */
  issues: string[];
}

export function parseCapabilities(json: string): Capabilities {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object") throw new Error("capabilities is not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.host !== "string" || !Array.isArray(o.codecs) || typeof o.webgpu !== "object" || typeof o.platform !== "object") throw new Error("capabilities has the wrong shape");
  return v as Capabilities;
}
