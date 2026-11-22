/**
 * The browser-side half of the capability probe (HostServices on the web; the Tauri webview uses it too).
 * Every probe fails soft: a throw, a rejection or a hang (> 4 s) becomes "unknown"/"unavailable", never an exception.
 * Output is the raw JSON the engine normalises (`app_core::capabilities_json`). No network requests.
 */
import type { Support } from "./capabilities";

const TIMEOUT_MS = 4000;

async function soft<T>(fallback: T, f: () => Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(f()), new Promise<T>((r) => { timer = setTimeout(() => r(fallback), TIMEOUT_MS); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// Codec strings in the profile most devices accept; AV1 and HEVC are the ones that vary by hardware.
export const CODECS = [
  { codec: "h264", tested: "avc1.640028", w: 1920, h: 1080 },
  { codec: "hevc", tested: "hvc1.1.6.L120.90", w: 1920, h: 1080 },
  { codec: "vp9", tested: "vp09.00.40.08", w: 1920, h: 1080 },
  { codec: "av1", tested: "av01.0.08M.08", w: 1920, h: 1080 },
] as const;

type Cfg = { codec: string; width: number; height: number; bitrate?: number; framerate?: number; hardwareAcceleration?: string };
interface Coder {
  isConfigSupported(c: Cfg): Promise<{ supported?: boolean }>;
}

async function support(api: Coder | undefined, cfg: Cfg): Promise<Support> {
  if (!api) return "no";
  return soft<Support>("unknown", async () => {
    if ((await api.isConfigSupported({ ...cfg, hardwareAcceleration: "prefer-hardware" })).supported) return "hardware";
    return (await api.isConfigSupported({ ...cfg, hardwareAcceleration: "no-preference" })).supported ? "supported" : "no";
  });
}

async function probeCodecs() {
  const g = globalThis as unknown as { VideoDecoder?: Coder; VideoEncoder?: Coder };
  return Promise.all(
    CODECS.map(async (c) => ({
      codec: c.codec,
      tested: c.tested,
      decode: await support(g.VideoDecoder, { codec: c.tested, width: c.w, height: c.h }),
      encode: await support(g.VideoEncoder, { codec: c.tested, width: c.w, height: c.h, bitrate: 8_000_000, framerate: 30 }),
    })),
  );
}

const LIMITS = ["maxTextureDimension2D", "maxBufferSize", "maxStorageBufferBindingSize", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxBindGroups", "maxColorAttachments"];

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  isFallbackAdapter?: boolean;
  limits?: Record<string, unknown>;
  features?: Iterable<string>;
}

async function probeWebGpu() {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return { available: false, error: "navigator.gpu is missing" };
  return soft<Record<string, unknown>>({ available: false, error: "WebGPU did not answer" }, async () => {
    const a = await gpu.requestAdapter();
    if (!a) return { available: false, error: "no GPU adapter" };
    const limits: Record<string, number> = {};
    for (const k of LIMITS) {
      const n = a.limits?.[k];
      if (typeof n === "number") limits[k] = n;
    }
    return {
      available: true,
      adapter: { vendor: a.info?.vendor ?? "", architecture: a.info?.architecture ?? "", device: a.info?.device ?? "", description: a.info?.description ?? "", fallback: !!a.isFallbackAdapter },
      limits,
      features: [...(a.features ?? [])].slice(0, 40),
    };
  });
}

function probeWebGl2() {
  return soft<Record<string, unknown>>({ available: false }, () => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return { available: false };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      available: true,
      renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      max_texture_size: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    };
  });
}

/** Raw probe of this browser or webview, as a JSON string for the engine. */
export async function probeHost(): Promise<string> {
  const nav = navigator as unknown as { deviceMemory?: number; storage?: { getDirectory?: unknown } };
  const [codecs, webgpu, webgl2] = await Promise.all([soft([], probeCodecs), soft<Record<string, unknown>>({ available: false }, probeWebGpu), probeWebGl2()]);
  return JSON.stringify({
    platform: {
      user_agent: navigator.userAgent,
      platform: navigator.platform,
      hardware_concurrency: navigator.hardwareConcurrency || null,
      device_memory_gb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    },
    codecs,
    webgpu,
    webgl2,
    shared_array_buffer: typeof SharedArrayBuffer !== "undefined",
    cross_origin_isolated: !!globalThis.crossOriginIsolated,
    opfs: typeof nav.storage?.getDirectory === "function",
    web_workers: typeof Worker !== "undefined",
    offscreen_canvas: typeof OffscreenCanvas !== "undefined",
  });
}
