// Runs inside a dedicated Worker (the engine's home on the web) for tests/smoke/decode.spec.ts: opens the demux fixtures through the
// real wasm `MediaFile` + WebCodecs host, and reports what happened. Assertions live in the spec (Node side) for readable failures.
import init, { MediaFile } from "@app/wasm-pkg";
import { createWebMedia, type WasmMediaClass } from "../../packages/engine-client/src/decode/media";
import { WebCodecsHost } from "../../packages/engine-client/src/decode/host";
import { blobSource } from "../../packages/engine-client/src/decode/blob-source";
import type { MediaHandle } from "../../packages/engine-client/src/types";

interface Input { wasm: ArrayBuffer; fixtures: Record<string, ArrayBuffer> }

/** FNV-1a over the pixels: exact-equality fingerprint (decoding is deterministic, so a seeked frame must equal the linear one). */
function hash(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** Independent reference: a bare VideoDecoder fed every packet once, front to back, no seeking. Frame i = i-th by timestamp. */
async function linearReference(bytes: ArrayBuffer): Promise<string[]> {
  const blob = new Blob([bytes]);
  const src = blobSource(blob);
  const mf = await MediaFile.open(src);
  const packets = JSON.parse(mf.videoPacketsJson()) as { offset: number; size: number; key: boolean; ts: number; dur: number }[];
  const info = JSON.parse(mf.info()).video as { codec: string; width: number; height: number };
  const frames: VideoFrame[] = [];
  const dec = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { throw e; } });
  dec.configure({ codec: info.codec, codedWidth: info.width, codedHeight: info.height, description: mf.videoDescription() });
  for (const p of packets) dec.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.ts, duration: p.dur, data: await src.read(p.offset, p.size) }));
  await dec.flush();
  dec.close();
  mf.free();
  frames.sort((a, b) => a.timestamp - b.timestamp);
  const out: string[] = [];
  for (const f of frames) {
    const px = new Uint8Array(f.allocationSize({ format: "RGBA" }));
    await f.copyTo(px, { format: "RGBA" });
    out.push(hash(px));
    f.close();
  }
  return out;
}

/** Seeded Fisher-Yates so every run seeks in the same awkward order. */
function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = 12345;
  for (let i = n - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

function crossings(x: Float32Array, ch: number, channels: number): number {
  let c = 0;
  for (let i = 1; i < x.length / channels; i++) if ((x[(i - 1) * channels + ch]! < 0) !== (x[i * channels + ch]! < 0)) c++;
  return c;
}

self.onmessage = async (ev: MessageEvent<Input>) => {
  try {
    const { wasm, fixtures } = ev.data;
    await init({ module_or_path: wasm });
    const media = createWebMedia(MediaFile as unknown as WasmMediaClass);
    const out: Record<string, unknown> = { webgpu: "gpu" in navigator, hwconc: navigator.hardwareConcurrency };
    for (const [name, bytes] of Object.entries(fixtures)) {
      const ref = await linearReference(bytes);
      const r: Record<string, unknown> = {};
      // Range reads only: count the bytes the engine asks the Blob for.
      const real = new Blob([bytes]);
      let bytesRead = 0, maxRead = 0;
      const counting = { size: real.size, slice: (a: number, b: number) => { bytesRead += b - a; maxRead = Math.max(maxRead, b - a); return real.slice(a, b); } } as unknown as Blob;
      const h: MediaHandle = await media.open(counting, { gpu: false });
      r.info = h.info;
      r.frameKind = h.frameKind;
      const n = h.info.video?.packets ?? 0;
      // 1. Random-order seeks (CPU RGBA): each frame must be the requested one (nearest ffmpeg reference == index) and carry its pts.
      const t0 = performance.now();
      const seeks: { i: number; index: number; pts: number; hash: string; w: number; h: number }[] = [];
      const lat: number[] = [];
      for (const i of shuffled(n)) {
        const s = performance.now();
        const f = await h.videoFrame(i);
        lat.push(performance.now() - s);
        if (f.kind !== "cpu") throw new Error("expected a CPU frame");
        seeks.push({ i, index: f.index, pts: f.ptsTicks, hash: hash(f.rgba), w: f.width, h: f.height });
        f.release();
      }
      lat.sort((a, b) => a - b);
      r.seeks = seeks;
      r.seekMs = { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], total: performance.now() - t0 };
      r.ref = ref;
      r.afterSeeks = h.stats();
      r.bytesRead = bytesRead;
      r.maxRead = maxRead;
      r.fileSize = real.size;
      // 2. Scrubbing: fire many seeks without waiting; the last must resolve, older ones resolve or are cancelled, nothing else fails.
      const settled = await Promise.allSettled(Array.from({ length: 24 }, (_, k) => h.videoFrame((k * 7) % n)));
      const kinds = settled.map((s) => (s.status === "fulfilled" ? "ok" : (s.reason as { kind?: string }).kind ?? String(s.reason)));
      for (const s of settled) if (s.status === "fulfilled") s.value.release();
      r.scrub = { kinds, lastOk: kinds[kinds.length - 1] === "ok", cancelled: kinds.filter((k) => k === "cancelled").length, other: kinds.filter((k) => k !== "ok" && k !== "cancelled") };
      r.afterScrub = h.stats();
      await h.close();
      // 3. GPU path: VideoFrame handles, closed on release; the count of open frames tracks what we hold.
      const g = await media.open(real, { gpu: true });
      r.gpuKind = g.frameKind;
      if (g.frameKind === "gpu") {
        const held = [await g.videoFrame(0), await g.videoFrame(n - 1), await g.videoFrame(Math.floor(n / 2))];
        r.gpuHeld = { kinds: held.map((f) => f.kind), instance: held.every((f) => f.kind === "gpu" && f.frame instanceof VideoFrame), open: g.stats().open, size: held.map((f) => f.kind === "gpu" ? [f.frame.codedWidth, f.frame.codedHeight] : null) };
        const first = held[0]!;
        const ts = first.kind === "gpu" ? first.frame.timestamp : -1;
        held.forEach((f) => f.release());
        r.gpuFirstTs = ts;
        r.gpuAfter = g.stats();
      }
      await g.close();
      // 4. Audio at the file rate and resampled to 44.1 kHz: right length, the 440 Hz sine, silence-free.
      if (h.info.audio) {
        const a = await media.open(real, { gpu: false, audioRate: 48_000 });
        const ch = a.info.audio!.channels;
        const x = await a.audio(24_000, 4_800);
        const b = await media.open(real, { gpu: false, audioRate: 44_100 });
        const y = await b.audio(22_050, 4_410);
        const peak = (v: Float32Array) => v.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
        r.audio = { channels: ch, len48: x.length, len44: y.length, peak48: peak(x), peak44: peak(y), cross48: crossings(x, 0, ch), cross44: crossings(y, 0, ch), total: a.info.audio!.packets };
        await a.close();
        await b.close();
      }
      out[name] = r;
    }
    // 5. A large file is never loaded whole: the same MP4 plus a 64 MB trailing `free` box. Open + two seeks must read a sliver of it.
    {
      const bytes = fixtures["h264_aac.mp4"]!;
      const FREE = 64 * 1024 * 1024;
      const head = new Uint8Array(8);
      new DataView(head.buffer).setUint32(0, FREE); // 32-bit box size
      head.set([0x66, 0x72, 0x65, 0x65], 4); // "free"
      const real = new Blob([bytes, head, new Uint8Array(FREE - 8)]);
      let read = 0;
      const counting = { size: real.size, slice: (a: number, b: number) => { read += b - a; return real.slice(a, b); } } as unknown as Blob;
      const h = await media.open(counting, { gpu: false });
      const f0 = await h.videoFrame(0);
      const f1 = await h.videoFrame(h.info.video!.packets - 1);
      const ref = await linearReference(bytes);
      out.big = { size: real.size, read, h0: f0.kind === "cpu" ? hash(f0.rgba) === ref[0] : false, h1: f1.kind === "cpu" ? hash(f1.rgba) === ref[ref.length - 1] : false };
      f0.release(); f1.release();
      await h.close();
    }
    // 6. Errors name the codec; a bad file is `invalid`, not a hang.
    const fx = Object.values(fixtures)[0]!;
    const errs: Record<string, unknown> = {};
    try {
      await WebCodecsHost.create(blobSource(new Blob([fx])), { video: { codec: "avc1.ffffff", width: 160, height: 120, description: new Uint8Array() } });
    } catch (e) { errs.unsupported = { kind: (e as { kind?: string }).kind, message: (e as Error).message }; }
    try { await media.open(new Blob([new Uint8Array(64)])); } catch (e) { errs.garbage = { kind: (e as { kind?: string }).kind, message: (e as Error).message }; }
    out.errors = errs;
    (self as unknown as Worker).postMessage({ ok: true, out });
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
