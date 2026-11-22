/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU has no types in the TS DOM lib; this file talks to it loosely and every call is fail-soft. */
// Device benchmark. Runs in a Worker so the page stays responsive. Method follows the S1 spike (docs/adr/0004-media-io.md):
// real 1080p H.264 clips (High profile, 2 B-frames, frame number burned in), random seeks from the previous keyframe.
// Test media are the app's own static assets (/diagnostics/*): no other network request is made.
import { rng, summarize } from "./stats";
import type { FromWorker, TestId, TestResult, ToWorker } from "./types";

const ctx = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null; location: Location };
const W = 1920, H = 1080;

interface Packet { pos: number; size: number; pts: number; dts: number; key: boolean; n: number }
interface Clip { bytes: Uint8Array; packets: Packet[]; frames: number; byN: Map<number, number>; config: VideoDecoderConfig }

const clipCache = new Map<string, Promise<Clip>>();
function loadClip(name: string): Promise<Clip> {
  let p = clipCache.get(name);
  if (!p) {
    p = (async () => {
      const get = (ext: string) => fetch(new URL(`/diagnostics/${name}.${ext}`, ctx.location.origin)).then((r) => { if (!r.ok) throw new Error(`${name}.${ext}: HTTP ${r.status}`); return r; });
      const [buf, idx] = await Promise.all([get("mp4").then((r) => r.arrayBuffer()), get("json").then((r) => r.json() as Promise<{ frames: number; packets: Packet[] }>)]);
      const bytes = new Uint8Array(buf);
      let at = -1; // the avcC box holds the decoder configuration
      for (let i = 4; i < 4096; i++) if (bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x63 && bytes[i + 3] === 0x43) { at = i; break; }
      if (at < 0) throw new Error("test clip has no avcC box");
      const size = new DataView(buf).getUint32(at - 4);
      const description = bytes.slice(at + 4, at - 4 + size);
      const codec = `avc1.${[...description.slice(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      return { bytes, packets: idx.packets, frames: idx.frames, byN: new Map(idx.packets.map((q, i) => [q.n, i])), config: { codec, codedWidth: W, codedHeight: H, description, optimizeForLatency: true } };
    })();
    clipCache.set(name, p);
  }
  return p;
}

const chunk = (clip: Clip, pk: Packet) => new EncodedVideoChunk({ type: pk.key ? "key" : "delta", timestamp: pk.pts, data: clip.bytes.subarray(pk.pos, pk.pos + pk.size) });

class Unsupported extends Error {}
async function requireDecoder(clip: Clip) {
  if (typeof VideoDecoder === "undefined") throw new Unsupported("This browser has no WebCodecs video decoder.");
  const s = await VideoDecoder.isConfigSupported(clip.config);
  if (!s.supported) throw new Unsupported("This device cannot decode H.264 (High profile, 1080p).");
}

/** Decode to the frame for display number `n`, starting from the keyframe at or before it (B-frame aware). */
function makeSeeker(clip: Clip) {
  let wanted: { ts: number; resolve: (f: VideoFrame) => void } | null = null;
  const decoder = new VideoDecoder({
    output: (f) => { if (wanted && f.timestamp === wanted.ts) { wanted.resolve(f); wanted = null; } else f.close(); },
    error: () => undefined, // surfaced by the timeout below
  });
  decoder.configure(clip.config);
  return {
    async seek(n: number): Promise<VideoFrame> {
      const t = clip.byN.get(n)!;
      const target = clip.packets[t]!;
      let k = t;
      while (!clip.packets[k]!.key) k--;
      let end = t;
      while (end + 1 < clip.packets.length && clip.packets[end + 1]!.dts <= target.pts) end++;
      const got = new Promise<VideoFrame>((resolve) => { wanted = { ts: target.pts, resolve }; });
      for (let i = k; i <= end; i++) decoder.decode(chunk(clip, clip.packets[i]!));
      await decoder.flush();
      return Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`frame ${n} was never produced`)), 5000))]);
    },
    close() { try { decoder.close(); } catch { /* already closed */ } },
  };
}

const targets = (clip: Clip, count: number, seed: number) => { const r = rng(seed); return Array.from({ length: count }, () => Math.floor(r() * clip.frames)); };
const progress = (id: TestId, frac: number) => ctx.postMessage({ type: "progress", id, frac });

// 1. Sequential decode throughput (what importing and playing cost).
async function decodeTest(): Promise<Record<string, number | string>> {
  const clip = await loadClip("clip-gop30");
  await requireDecoder(clip);
  const runs: number[] = [];
  for (let r = 0; r < 3; r++) {
    let out = 0;
    const d = new VideoDecoder({ output: (f) => { out++; f.close(); }, error: () => undefined });
    d.configure(clip.config);
    const t0 = performance.now();
    for (const pk of clip.packets) d.decode(chunk(clip, pk));
    await d.flush();
    runs.push(performance.now() - t0);
    d.close();
    if (out !== clip.frames) throw new Error(`decoded ${out} of ${clip.frames} frames`);
    progress("decode", (r + 1) / 3);
  }
  const steady = Math.min(runs[1]!, runs[2]!);
  return { frames: clip.frames, fps: Math.round((clip.frames / steady) * 1000), first_run_ms: Math.round(runs[0]!) };
}

// 2. Random seek latency on a short-GOP and a long-GOP clip (long GOPs are what phones record).
async function seekTest(): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  let step = 0;
  for (const [name, label] of [["clip-gop30", "gop30"], ["clip-gop150", "gop150"]] as const) {
    const clip = await loadClip(name);
    await requireDecoder(clip);
    const seeker = makeSeeker(clip);
    const ms: number[] = [];
    const list = targets(clip, 48, 12345);
    try {
      for (let i = 0; i < list.length; i++) {
        const t0 = performance.now();
        const f = await seeker.seek(list[i]!);
        const dt = performance.now() - t0;
        f.close();
        if (i >= 8) ms.push(dt); // first 8 warm the decoder
        progress("seek", (step + (i + 1) / list.length) / 2);
      }
    } finally { seeker.close(); }
    const s = summarize(ms);
    out[`${label}_p50_ms`] = s.p50; out[`${label}_p95_ms`] = s.p95; out[`${label}_max_ms`] = s.max;
    step++;
  }
  return out;
}

// WebGPU plumbing shared by tests 3 and 4.
const SAMPLE = (tex: string, call: string) => `
@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var ${tex};
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return ${call}; }`;
const FMT = "rgba8unorm";

async function gpuDevice(): Promise<{ device: any; info: string }> {
  const gpu = (navigator as any).gpu;
  if (!gpu) throw new Unsupported("WebGPU is not available here (in a worker).");
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Unsupported("No graphics adapter for WebGPU.");
  const device = await adapter.requestDevice();
  const i = adapter.info ?? {};
  return { device, info: [i.vendor, i.architecture, adapter.isFallbackAdapter ? "software" : ""].filter(Boolean).join(" ") };
}

const p50p95 = (a: number[]) => { const s = summarize(a); return { p50: s.p50, p95: s.p95 }; };

// 3. How a decoded frame reaches a GPU texture (S1: direct import vs copy vs CPU upload).
async function gpuUploadTest(): Promise<Record<string, number | string>> {
  const clip = await loadClip("clip-gop30");
  await requireDecoder(clip);
  const { device, info } = await gpuDevice();
  const out: Record<string, number | string> = { gpu: info };
  const mk = (code: string) => { const module = device.createShaderModule({ code }); return device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: FMT }] } }); };
  const pExt = mk(SAMPLE("texExt: texture_external", `textureSampleBaseClampToEdge(texExt, smp, pos.xy / vec2f(${W}, ${H}))`));
  const p2d = mk(SAMPLE("tex2d: texture_2d<f32>", `textureSample(tex2d, smp, pos.xy / vec2f(${W}, ${H}))`));
  const target = device.createTexture({ size: [W, H], format: FMT, usage: 16 /* RENDER_ATTACHMENT */ });
  const upload = device.createTexture({ size: [W, H], format: FMT, usage: 4 | 2 | 16 /* TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT */ });
  const smp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const draw = (pipe: any, resource: any) => {
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: smp }, { binding: 1, resource }] });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    device.queue.submit([enc.finish()]);
  };
  const paths: Record<string, (f: VideoFrame) => Promise<void>> = {
    direct: async (f) => draw(pExt, device.importExternalTexture({ source: f })),
    copy: async (f) => { device.queue.copyExternalImageToTexture({ source: f }, { texture: upload }, [f.displayWidth, f.displayHeight]); draw(p2d, upload.createView()); },
    cpu: async (f) => {
      const buf = new Uint8Array(f.displayWidth * f.displayHeight * 4);
      await f.copyTo(buf, { format: "RGBA" });
      device.queue.writeTexture({ texture: upload }, buf, { bytesPerRow: f.displayWidth * 4 }, [f.displayWidth, f.displayHeight]);
      draw(p2d, upload.createView());
    },
  };
  const seeker = makeSeeker(clip);
  const list = targets(clip, 30, 777);
  const times: Record<string, number[]> = { direct: [], copy: [], cpu: [] };
  const failed: Record<string, string> = {};
  try {
    for (let i = 0; i < list.length; i++) {
      const f = await seeker.seek(list[i]!);
      for (const [name, run] of Object.entries(paths)) {
        if (failed[name]) continue;
        try {
          const t0 = performance.now();
          await run(f);
          await device.queue.onSubmittedWorkDone();
          if (i >= 4) times[name]!.push(performance.now() - t0);
        } catch (e) { failed[name] = e instanceof Error ? e.message : String(e); }
      }
      f.close();
      progress("gpuUpload", (i + 1) / list.length);
    }
  } finally { seeker.close(); device.destroy?.(); }
  for (const name of Object.keys(paths)) {
    if (failed[name] || times[name]!.length === 0) { out[`${name}_p50_ms`] = "failed"; out[`${name}_error`] = (failed[name] ?? "no samples").slice(0, 80); continue; }
    const s = p50p95(times[name]!);
    out[`${name}_p50_ms`] = s.p50; out[`${name}_p95_ms`] = s.p95;
  }
  return out;
}

// 4. Fill rate: full-HD layers with a little shader maths, alpha blended, like stacked overlays and effects.
async function fillRateTest(): Promise<Record<string, number | string>> {
  const { device, info } = await gpuDevice();
  const LAYERS = 8, FRAMES = 90;
  const module = device.createShaderModule({ code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3)); return vec4f(p[i], 0, 1); }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(${W}, ${H});
  var c = vec3f(uv, 0.5);
  for (var i = 0; i < 6; i++) { c = c * 0.9 + 0.1 * vec3f(sin(c.y * 7.0 + f32(i)), cos(c.x * 5.0), sin(c.z * 3.0)); }
  return vec4f(c * 0.5 + 0.25, 0.35);
}` });
  const pipe = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: FMT, blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }] } });
  const target = device.createTexture({ size: [W, H], format: FMT, usage: 16 });
  const view = target.createView();
  const ms: number[] = [];
  const t00 = performance.now();
  try {
    for (let f = 0; f < FRAMES + 10; f++) {
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(pipe);
      for (let l = 0; l < LAYERS; l++) pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      if (f >= 10) ms.push(performance.now() - t0);
      if (f % 10 === 0) progress("fillRate", Math.min(1, f / (FRAMES + 10)));
      if (performance.now() - t00 > 12_000) break; // very slow GPUs: report what we have
    }
  } finally { device.destroy?.(); }
  const s = summarize(ms);
  return { gpu: info, layers: LAYERS, frame_p50_ms: s.p50, frame_p95_ms: s.p95, layers_at_60fps: Math.round((LAYERS * 16.7) / Math.max(s.p50, 0.1)), frames: s.n };
}

const RUNNERS: Record<TestId, () => Promise<Record<string, number | string>>> = { decode: decodeTest, seek: seekTest, gpuUpload: gpuUploadTest, fillRate: fillRateTest };

ctx.onmessage = async (e) => {
  if (e.data.type !== "run") return;
  const id = e.data.id;
  const t0 = performance.now();
  let result: TestResult;
  try {
    result = { id, status: "ok", metrics: await RUNNERS[id](), took_ms: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { id, status: err instanceof Unsupported ? "unsupported" : "error", reason: msg.slice(0, 160), metrics: {}, took_ms: 0 };
  }
  result.took_ms = Math.round(performance.now() - t0);
  ctx.postMessage({ type: "result", result });
};
