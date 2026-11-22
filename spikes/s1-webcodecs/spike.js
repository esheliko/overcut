// S1 spike (M1-010): WebCodecs VideoFrame -> WebGPU, frame-accurate seek, latency.
// Self-contained; not part of the app bundle. Result lands in window.__result.
const CODE_BITS = 16, BLOCK = 64;

const q = new URLSearchParams(location.search);
const CLIP = q.get("clip") ?? "clip-gop30";
const ONLY = q.get("mode");
const SEEKS = +(q.get("seeks") ?? 60), WARMUP = 8;

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats = (a) => ({ n: a.length, p50: +pct(a, 50).toFixed(1), p95: +pct(a, 95).toFixed(1), max: +Math.max(...a).toFixed(1) });

async function load() {
  const [buf, idx] = await Promise.all([
    fetch(`./${CLIP}.mp4`).then((r) => r.arrayBuffer()),
    fetch(`./${CLIP}.json`).then((r) => r.json()),
  ]);
  const bytes = new Uint8Array(buf);
  // find the avcC box (decoder config) in the sample entry
  let at = -1;
  for (let i = 4; i < 4096; i++) if (bytes[i] === 0x61 && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x63 && bytes[i + 3] === 0x43) { at = i; break; }
  const size = new DataView(buf).getUint32(at - 4);
  const description = bytes.slice(at + 4, at - 4 + size);
  const codec = `avc1.${[...description.slice(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const byN = new Map(idx.packets.map((p, i) => [p.n, i])); // packets are listed in decode order
  return { bytes, idx, description, codec, byN };
}

// feed packets from the keyframe at/before the target; resolve with the target frame
function makeSeeker(clip, decoderConfig) {
  const { bytes, idx } = clip;
  let wanted = null;
  const decoder = new VideoDecoder({
    output: (f) => {
      if (wanted && f.timestamp === wanted.ts) { wanted.resolve(f); wanted = null; } else f.close();
    },
    error: (e) => { throw e; },
  });
  decoder.configure(decoderConfig);
  return {
    async seek(n) {
      const t = clip.byN.get(n);
      const target = idx.packets[t];
      let k = t;
      while (!idx.packets[k].key) k--;
      // B-frames: feed every packet whose dts <= target pts; flush drains the reorder queue
      let end = t;
      while (end + 1 < idx.packets.length && idx.packets[end + 1].dts <= target.pts) end++;
      const p = new Promise((resolve) => { wanted = { ts: target.pts, resolve }; });
      for (let i = k; i <= end; i++) {
        const pk = idx.packets[i];
        decoder.decode(new EncodedVideoChunk({ type: pk.key ? "key" : "delta", timestamp: pk.pts, data: bytes.subarray(pk.pos, pk.pos + pk.size) }));
      }
      await decoder.flush();
      const frame = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("target frame never output " + n)), 5000))]);
      return { frame, decoded: end - k + 1 };
    },
  };
}

const SHADER = `
@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var texExt: texture_external;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fsExt(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(texExt, smp, pos.xy / vec2f(1920, 1080));
}`;
const SHADER_2D = `
@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var tex2d: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs2d(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureSample(tex2d, smp, pos.xy / vec2f(1920, 1080));
}`;

async function gpuSetup(w, h) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const fmt = "rgba8unorm";
  const mk = (code, frag) => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: frag, targets: [{ format: fmt }] } });
  };
  const target = device.createTexture({ size: [w, h], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const upload = device.createTexture({ size: [w, h], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  const readbuf = device.createBuffer({ size: 4096, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const smp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const info = adapter.info ?? {};
  return { adapter, device, target, upload, readbuf, smp, pExt: mk(SHADER, "fsExt"), p2d: mk(SHADER_2D, "fs2d"),
    info: { vendor: info.vendor, architecture: info.architecture, description: info.description, fallback: adapter.isFallbackAdapter } };
}

function draw(g, pipeline, resource) {
  const { device } = g;
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: g.smp }, { binding: 1, resource }] });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: g.target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
  enc.copyTextureToBuffer({ texture: g.target, origin: [0, BLOCK / 2] }, { buffer: g.readbuf, bytesPerRow: 4096 }, [CODE_BITS * BLOCK, 1]);
  device.queue.submit([enc.finish()]);
}

async function readCode(g) {
  await g.readbuf.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(g.readbuf.getMappedRange());
  let n = 0;
  for (let b = 0; b < CODE_BITS; b++) n = (n << 1) | (px[(b * BLOCK + BLOCK / 2) * 4] > 128 ? 1 : 0);
  g.readbuf.unmap();
  return n;
}

// a path = how a decoded VideoFrame reaches a GPU texture the compositor can sample
const PATHS = {
  importExternalTexture: async (g, f) => draw(g, g.pExt, g.device.importExternalTexture({ source: f })),
  copyExternalImageToTexture: async (g, f) => {
    g.device.queue.copyExternalImageToTexture({ source: f }, { texture: g.upload }, [f.displayWidth, f.displayHeight]);
    draw(g, g.p2d, g.upload.createView());
  },
  cpuUpload: async (g, f) => {
    const buf = new Uint8Array(f.displayWidth * f.displayHeight * 4);
    await f.copyTo(buf, { format: "RGBA" });
    g.device.queue.writeTexture({ texture: g.upload }, buf, { bytesPerRow: f.displayWidth * 4 }, [f.displayWidth, f.displayHeight]);
    draw(g, g.p2d, g.upload.createView());
  },
};

async function run() {
  const res = { clip: CLIP, ua: navigator.userAgent, support: {}, paths: {} };
  const clip = await load();
  const cfg = { codec: clip.codec, codedWidth: clip.idx.width, codedHeight: clip.idx.height, description: clip.description, optimizeForLatency: true };
  for (const hw of ["no-preference", "prefer-hardware", "prefer-software"]) {
    try { res.support[hw] = (await VideoDecoder.isConfigSupported({ ...cfg, hardwareAcceleration: hw })).supported; } catch (e) { res.support[hw] = String(e); }
  }
  res.codec = clip.codec;
  res.webgpu = !!navigator.gpu;
  const probeGpu = navigator.gpu ? await gpuSetup(clip.idx.width, clip.idx.height) : null;
  res.gpu = probeGpu ? probeGpu.info : null;
  const seeker = makeSeeker(clip, cfg);
  const rand = rng(12345);
  const targets = Array.from({ length: SEEKS + WARMUP }, () => Math.floor(rand() * clip.idx.frames));
  targets.push(0, clip.idx.frames - 1); // edges

  const modes = ONLY ? [ONLY] : ["decodeOnly", ...(probeGpu ? Object.keys(PATHS) : [])];
  for (const mode of modes) {
    // fresh device per path so one path's failure cannot poison the next
    const g = mode === "decodeOnly" ? null : await gpuSetup(clip.idx.width, clip.idx.height);
    if (g) { g.device.lost.then((l) => errors0.push("device lost: " + l.reason + " " + l.message)); g.device.onuncapturederror = (e) => errors0.push("gpu error: " + e.error.message); }
    const errors0 = [];
    const decodeMs = [], totalMs = [], decoded = [], bad = [], errors = [];
    for (let i = 0; i < targets.length; i++) {
      const n = targets[i];
      const t0 = performance.now();
      const { frame, decoded: cnt } = await seeker.seek(n);
      const t1 = performance.now();
      let ok = true, got = null;
      if (mode !== "decodeOnly") {
        try {
          await PATHS[mode](g, frame);
          await g.device.queue.onSubmittedWorkDone();
          const t2 = performance.now();
          got = await readCode(g);
          ok = got === n;
          if (i >= WARMUP) totalMs.push(t2 - t0);
        } catch (e) { errors.push(String(e)); ok = false; }
      }
      if (i >= WARMUP) { decodeMs.push(t1 - t0); decoded.push(cnt); }
      if (!ok) bad.push({ want: n, got });
      frame.close();
    }
    errors.push(...errors0);
    res.paths[mode] = { decodeMs: stats(decodeMs), toGpuMs: totalMs.length ? stats(totalMs) : null, framesDecodedPerSeek: stats(decoded), wrongFrames: bad.length, wrongSample: bad.slice(0, 3), errors: [...new Set(errors)].slice(0, 3) };
  }
  let sweepBad = 0;
  for (let n = 0; n < clip.idx.frames; n += 7) {
    const { frame } = await seeker.seek(n);
    if (Math.abs(frame.timestamp - clip.idx.packets[clip.byN.get(n)].pts) > 1) sweepBad++;
    frame.close();
  }
  res.timestampSweepMismatches = sweepBad;
  return res;
}

run().then((r) => { window.__result = r; document.getElementById("out").textContent = JSON.stringify(r, null, 2); })
  .catch((e) => { window.__result = { error: String(e?.stack ?? e) }; document.getElementById("out").textContent = String(e?.stack ?? e); });
