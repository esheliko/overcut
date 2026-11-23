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

// WebGL2 plumbing (phones without WebGPU, and the browsers' second path): a full-screen triangle sampling one texture.
const GL_VS = "#version 300 es\nvoid main(){ vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.)); gl_Position=vec4(p[gl_VertexID],0.,1.); }";
const GL_FS_TEX = "#version 300 es\nprecision mediump float; uniform sampler2D t; out vec4 o; void main(){ o=texture(t, gl_FragCoord.xy/vec2(1920.,1080.)); }";
const GL_FS_FILL = `#version 300 es
precision highp float; out vec4 o;
void main(){ vec2 uv=gl_FragCoord.xy/vec2(1920.,1080.); vec3 c=vec3(uv,.5);
  for(int i=0;i<6;i++){ c=c*.9+.1*vec3(sin(c.y*7.+float(i)),cos(c.x*5.),sin(c.z*3.)); }
  o=vec4(c*.5+.25,.35); }`;

interface Gl { gl: WebGL2RenderingContext; info: string; program(fs: string): WebGLProgram; finish(): void }
function openGl(): Gl | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const c = new OffscreenCanvas(W, H);
  const gl = c.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) return null;
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const info = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 80);
  const px = new Uint8Array(4);
  return {
    gl, info,
    program(fs) {
      const sh = (type: number, src: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) ?? "shader failed"); return x; };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, GL_VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
      return p;
    },
    finish() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }, // reading a pixel waits for the GPU
  };
}

type UploadPaths = Record<string, (f: VideoFrame) => Promise<void>>;
interface UploadApi { prefix: string; info: string; paths: UploadPaths; sync(): Promise<void>; dispose(): void }

async function webgpuUpload(): Promise<UploadApi | null> {
  let g: { device: any; info: string };
  try { g = await gpuDevice(); } catch (e) { if (e instanceof Unsupported) return null; throw e; }
  const { device, info } = g;
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
  return {
    prefix: "", info,
    paths: {
      // `direct` = importExternalTexture (zero copy). The compositor does not use it; it is measured so we never assume it is the fast one (S1: 4x slower on Intel UHD 630).
      direct: async (f) => draw(pExt, device.importExternalTexture({ source: f })),
      copy: async (f) => { device.queue.copyExternalImageToTexture({ source: f }, { texture: upload }, [f.displayWidth, f.displayHeight]); draw(p2d, upload.createView()); },
      cpu: async (f) => {
        const buf = new Uint8Array(f.displayWidth * f.displayHeight * 4);
        await f.copyTo(buf, { format: "RGBA" });
        device.queue.writeTexture({ texture: upload }, buf, { bytesPerRow: f.displayWidth * 4 }, [f.displayWidth, f.displayHeight]);
        draw(p2d, upload.createView());
      },
    },
    sync: () => device.queue.onSubmittedWorkDone(),
    dispose: () => device.destroy?.(),
  };
}

function webgl2Upload(): UploadApi | null {
  const g = openGl();
  if (!g) return null;
  const { gl } = g;
  const prog = g.program(GL_FS_TEX);
  gl.useProgram(prog);
  gl.viewport(0, 0, W, H);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
  return {
    prefix: "gl_", info: g.info,
    paths: {
      frame: async (f) => { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f as unknown as TexImageSource); draw(); },
      cpu: async (f) => {
        const buf = new Uint8Array(f.displayWidth * f.displayHeight * 4);
        await f.copyTo(buf, { format: "RGBA" });
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.displayWidth, f.displayHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        draw();
      },
    },
    sync: async () => g.finish(),
    dispose: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
  };
}

// 3. How a decoded frame reaches a GPU texture, on each API the device has: WebGPU (direct import vs copy vs CPU upload, S1) and WebGL2
// (texImage2D(VideoFrame) vs CPU upload; this is all a phone without WebGPU has). `fastest` names the quickest route measured.
async function gpuUploadTest(): Promise<Record<string, number | string>> {
  const clip = await loadClip("clip-gop30");
  await requireDecoder(clip);
  const apis = [await webgpuUpload(), webgl2Upload()].filter((a): a is UploadApi => a !== null);
  if (apis.length === 0) throw new Unsupported("Neither WebGPU nor WebGL2 is available here (in a worker).");
  const out: Record<string, number | string> = {};
  for (const a of apis) out[a.prefix ? "gl_gpu" : "gpu"] = a.info;
  const seeker = makeSeeker(clip);
  const list = targets(clip, 30, 777);
  const times: Record<string, number[]> = {};
  const failed: Record<string, string> = {};
  try {
    for (let i = 0; i < list.length; i++) {
      const f = await seeker.seek(list[i]!);
      for (const a of apis) {
        for (const [name, run] of Object.entries(a.paths)) {
          const id = a.prefix + name;
          if (failed[id]) continue;
          try {
            const t0 = performance.now();
            await run(f);
            await a.sync();
            if (i >= 4) (times[id] ??= []).push(performance.now() - t0);
          } catch (e) { failed[id] = e instanceof Error ? e.message : String(e); }
        }
      }
      f.close();
      progress("gpuUpload", (i + 1) / list.length);
    }
  } finally { seeker.close(); for (const a of apis) a.dispose(); }
  let fastest = "", fastestMs = Infinity;
  for (const a of apis) {
    for (const name of Object.keys(a.paths)) {
      const id = a.prefix + name;
      if (failed[id] || !times[id]?.length) { out[`${id}_p50_ms`] = "failed"; out[`${id}_error`] = (failed[id] ?? "no samples").slice(0, 80); continue; }
      const s = p50p95(times[id]!);
      out[`${id}_p50_ms`] = s.p50; out[`${id}_p95_ms`] = s.p95;
      if (s.p50 < fastestMs) { fastestMs = s.p50; fastest = `${a.prefix ? "webgl2" : "webgpu"} ${name}`; }
    }
  }
  if (fastest) { out.fastest = fastest; out.fastest_p50_ms = fastestMs; }
  return out;
}

// 4. Fill rate: full-HD layers with a little shader maths, alpha blended, like stacked overlays and effects.
const LAYERS = 8, FRAMES = 90;

/** The same blended full-HD layers on WebGL2: what a phone without WebGPU can do. */
async function fillRateGl(): Promise<Record<string, number | string> | null> {
  const g = openGl();
  if (!g) return null;
  const { gl } = g;
  try {
    gl.useProgram(g.program(GL_FS_FILL));
    gl.viewport(0, 0, W, H);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const ms: number[] = [];
    const t00 = performance.now();
    for (let f = 0; f < FRAMES + 10; f++) {
      const t0 = performance.now();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (let l = 0; l < LAYERS; l++) gl.drawArrays(gl.TRIANGLES, 0, 3);
      g.finish();
      if (f >= 10) ms.push(performance.now() - t0);
      if (f % 10 === 0) await Promise.resolve();
      if (performance.now() - t00 > 12_000) break;
    }
    const s = summarize(ms);
    return { gl_gpu: g.info, gl_layers: LAYERS, gl_frame_p50_ms: s.p50, gl_frame_p95_ms: s.p95, gl_layers_at_60fps: Math.round((LAYERS * 16.7) / Math.max(s.p50, 0.1)), gl_frames: s.n };
  } finally { gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}

async function fillRateTest(): Promise<Record<string, number | string>> {
  let gpuPart: Record<string, number | string> | null = null;
  try { gpuPart = await fillRateGpu(); } catch (e) { if (!(e instanceof Unsupported)) throw e; }
  const glPart = await fillRateGl();
  if (!gpuPart && !glPart) throw new Unsupported("Neither WebGPU nor WebGL2 is available here (in a worker).");
  return { ...gpuPart, ...glPart };
}

async function fillRateGpu(): Promise<Record<string, number | string>> {
  const { device, info } = await gpuDevice();
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

const RUNNERS: Record<Exclude<TestId, "playback" | "exportSpeed">, () => Promise<Record<string, number | string>>> = { decode: decodeTest, seek: seekTest, gpuUpload: gpuUploadTest, fillRate: fillRateTest };

ctx.onmessage = async (e) => {
  if (e.data.type !== "run") return;
  const id = e.data.id as Exclude<TestId, "playback" | "exportSpeed">;
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
