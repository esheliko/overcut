/**
 * The preview Worker (M1-023): the Rust GPU compositor on the transferred canvas, the player loop (`Player`), decoding and audio mixing, all off the
 * UI thread. The UI thread sends commands and the audible clock; it receives the playhead, state, and mixed audio to schedule.
 */
import { reportWorkerNetwork, openEvaluator, openMediaApi, openRenderer, layerOf, renderExportFrame, type DecodedFrame, type Evaluator, type GpuLayer, type GpuRenderer, type LayerSource, type MediaApi, type MediaHandle } from "@app/engine-client";
import { epochNow, type FromPreview, type PreviewConfig, type PreviewRpc, type ToPreview } from "./protocol";
import { Player, type AudioOut } from "./player";
import { frameStartTicks } from "./timing";
import { ThumbStore } from "./scrubCache";
import { createRemoteMedia, type NativeCall } from "./nativeMedia";
import { StripManager } from "./strip/manager";
import { chooseUploadPath, median, parseChoice, uploadKey, UPLOAD_PATHS, type UploadChoice, type UploadPath } from "./uploadPath";

reportWorkerNetwork(); // visible network log (XT-06)
const scope = self as unknown as {
  postMessage(m: FromPreview, transfer?: Transferable[]): void;
  addEventListener(type: "message", l: (e: MessageEvent<ToPreview>) => void): void;
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};
const post = (m: FromPreview, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);

let canvas: OffscreenCanvas | undefined;
let gpu: GpuRenderer | undefined;
let ev: Evaluator | undefined;
let handles = new Map<string, MediaHandle>();
let player: Player | undefined;
let cfg: PreviewConfig | undefined;
let mediaApi: MediaApi | undefined;
let remote: ReturnType<typeof createRemoteMedia> | undefined;
let projectJson = "";
let backing = { width: 1, height: 1 };

// --- the audible clock, sampled by the UI thread and extrapolated here ---------------------------------------------------------------------------
let anchor: { audio: number; epoch: number } | undefined;
const audioClock = { now: () => (anchor ? anchor.audio + (epochNow() - anchor.epoch) / 1000 : performance.now() / 1000) };
let nextReq = 1;
const pending = new Map<number, (v: unknown) => void>();
const callNative: NativeCall = (op) => new Promise((res) => { const id = nextReq++; pending.set(id, res as (v: unknown) => void); post({ type: "request", id, name: "native", op }); });
const request = (name: "audio-resume"): Promise<unknown> => new Promise((res) => { const id = nextReq++; pending.set(id, res); post({ type: "request", id, name }); });
const requestUpload = (key: string): Promise<unknown> => new Promise((res) => { const id = nextReq++; pending.set(id, res); post({ type: "request", id, name: "upload-get", key }); });

// --- how decoded frames reach the GPU: measured per device on the first real frame, cached by GPU + browser version (uploadPath.ts) ------------
let upload: UploadChoice | undefined;
let deciding: Promise<void> | undefined;
/** The last measuring run was disturbed by playback: nothing was stored, measure again on the next idle frame. */
let disturbed = false;
/** Where the upload-path decision is (for `rpc gpu` and the device report): `none` until a GPU frame was drawn. */
let uploadState = "none";
const rgbaSlots: Uint8Array[] = [];
const thumbs = new ThumbStore<ImageBitmap>();
/** Background scrub strips for clips that seek slowly (`strip/`, docs/features/preview.md "Smooth scrubbing"). Waits while the player is busy. */
const strips = new StripManager({ idle: () => player?.isIdle() ?? true, progress: (progress) => post({ type: "strip", progress }) });

/**
 * p50 of each upload path (ms), measured on a scratch compositor (never presented, so it can read back; the 64x64 readback waits for the GPU) with
 * `sample` drawn each time. The two paths run alternately (frame, cpu, frame, cpu...) after 4 warm-up rounds, so whatever else the device is doing
 * hits both alike; 12 timed rounds each.
 */
async function measureUploads(sample: VideoFrame, width: number, height: number): Promise<Record<UploadPath, number | null>> {
  const c = new OffscreenCanvas(64, 64);
  const r = await openRenderer(c, gpu!.info.backend);
  try {
    r.resize(64, 64);
    const buf = new Uint8Array(sample.allocationSize({ format: "RGBA" }));
    const times: Record<UploadPath, number[]> = { frame: [], cpu: [] };
    const failed: Record<UploadPath, boolean> = { frame: false, cpu: false };
    for (let i = 0; i < 16; i++) {
      if (player?.isPlaying) break; // playback started: the run is void anyway (`undisturbed`), stop taking the GPU from it at once
      for (const path of UPLOAD_PATHS) {
        if (failed[path]) continue;
        try {
          const t0 = performance.now();
          let source: LayerSource = sample;
          if (path === "cpu") { await sample.copyTo(buf, { format: "RGBA" }); source = { rgba: buf }; }
          await r.readback([{ source, width, height, rotation: 0, center: [width / 2, height / 2], scale: [1, 1], angle: 0, opacity: 1 }], { width, height }, { width: 64, height: 64 });
          if (i >= 4) times[path].push(performance.now() - t0);
        } catch { failed[path] = true; }
      }
    }
    return { frame: failed.frame ? null : median(times.frame), cpu: failed.cpu ? null : median(times.cpu) };
  } finally {
    r.dispose();
  }
}

function decideUpload(sample: VideoFrame, width: number, height: number): Promise<UploadChoice> {
  const key = uploadKey(gpu!.info.backend, gpu!.info.adapter, navigator.userAgent);
  disturbed = false;
  return chooseUploadPath({
    key,
    cached: requestUpload,
    save: (k, value) => post({ type: "upload-set", key: k, value }),
    measure: async () => null,
    measureAll: () => measureUploads(sample, width, height),
    // The run only counts if the player stayed idle the whole time (a clip being decoded and played shares the GPU with the measurement).
    undisturbed: () => (disturbed = !(player?.isIdle() && !player.isPlaying)) === false,
  });
}

/** Waits for the player to be idle (400 ms without play or scrub), measures on a clone of the first GPU frame, retries when playback disturbed the run. */
async function decideWhenIdle(f: DecodedFrame & { kind: "gpu" }): Promise<void> {
  uploadState = "asking-cache";
  const stored = parseChoice(await requestUpload(uploadKey(gpu!.info.backend, gpu!.info.adapter, navigator.userAgent)).catch(() => null));
  if (stored) { upload = stored; uploadState = "cached"; deciding = undefined; return; } // a cached choice needs no measuring, so no waiting for idle either
  const sample = f.frame.clone();
  try {
    for (let tries = 0; !upload && tries < 40; tries++) {
      uploadState = `waiting-idle (try ${tries})`;
      while (!(player?.isIdle() && !player.isPlaying)) await new Promise((r) => setTimeout(r, 250));
      uploadState = `measuring (try ${tries})`;
      const u = await decideUpload(sample, f.width, f.height).catch((e): UploadChoice => { uploadState = `measure-threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120); return { path: "frame", ms: {}, source: "default" }; });
      if (!disturbed) { upload = u; uploadState = `done (${u.source})`; }
    }
  } catch (e) {
    uploadState = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
  } finally {
    sample.close();
    deciding = undefined;
  }
}

/**
 * Safety net for a wrong choice (a measurement can still be fooled by a busy device): while playing on the `cpu` path, if over 2 seconds more than half
 * the frames were dropped, the `frame` path takes over and replaces the stored choice. `frame` never needs a CPU copy, so it is the safe side to fall back to.
 */
let guardLast = { presented: 0, dropped: 0 };
setInterval(() => {
  if (!player?.isPlaying || upload?.path !== "cpu") { guardLast = { presented: player?.stats.presented ?? 0, dropped: player?.stats.dropped ?? 0 }; return; }
  const presented = player.stats.presented - guardLast.presented, dropped = player.stats.dropped - guardLast.dropped;
  if (presented + dropped < 20) return; // too little to judge; keep counting
  guardLast = { presented: player.stats.presented, dropped: player.stats.dropped };
  if (dropped > presented) {
    upload = { path: "frame", ms: upload.ms, source: "measured" };
    post({ type: "upload-set", key: uploadKey(gpu!.info.backend, gpu!.info.adapter, navigator.userAgent), value: upload });
  }
}, 2000);

/**
 * The compositor's pixels for a decoded frame, by the chosen path. Until the (cached) measurement is in, frames take the `frame` path, which has never
 * lost on a real device; the measurement waits for an idle player so it does not compete with decoding and playback.
 */
async function uploadSource(f: DecodedFrame, slot: number): Promise<LayerSource> {
  if (f.kind === "cpu") return { rgba: f.rgba };
  if (!upload && !deciding) deciding = decideWhenIdle(f);
  if (!upload || upload.path === "frame") return f.frame;
  try {
    const n = f.frame.allocationSize({ format: "RGBA" });
    let buf = rgbaSlots[slot];
    if (!buf || buf.length !== n) rgbaSlots[slot] = buf = new Uint8Array(n);
    await f.frame.copyTo(buf, { format: "RGBA" });
    return { rgba: buf };
  } catch {
    upload = { ...upload, path: "frame" }; // this browser cannot convert: hand the frame over instead
    return f.frame;
  }
}

const audio: AudioOut = {
  sampleRate: 48_000,
  clock: audioClock,
  schedule(left, right, when) {
    // Chunks are views into the mixer's arrays: copy so the transfer does not detach anything the mixer still uses.
    const l = left.slice();
    const r = right.slice();
    post({ type: "audio", left: l as Float32Array<ArrayBuffer>, right: r as Float32Array<ArrayBuffer>, when }, [l.buffer as ArrayBuffer, r.buffer as ArrayBuffer]);
  },
  stop: () => post({ type: "audio-stop" }),
  async resume() {
    const r = (await request("audio-resume")) as { running: boolean; audio: number; epoch: number };
    if (r.running) anchor = { audio: r.audio, epoch: r.epoch };
    return r.running;
  },
};

const idleDescription = (ticks: number, n: number) => ({ time: ticks, frame: 0, video_time: ticks, sample: 0, audio_samples: n, layers: [], audio: [] });

/** The shared project changed (or the first config): swap the evaluator, create the player once, then reconfigure it. */
async function configure(c: PreviewConfig): Promise<void> {
  cfg = c;
  if (c.project !== projectJson) {
    const old = ev;
    ev = c.project ? await openEvaluator(c.project) : undefined;
    projectJson = c.project;
    old?.free();
  }
  if (player) player.reconfigure({ rate: c.rate, size: c.size, endTicks: c.endTicks, sequence: c.sequence });
  else startPlayer(c);
}

async function addMedia(id: string, file: File | { path: string }, fp?: string): Promise<void> {
  if (!mediaApi || handles.has(id)) return;
  const h = "path" in file ? await (remote ??= createRemoteMedia(callNative)).openPath(file.path) : await mediaApi.open(file, { audioRate: 48_000 });
  if (handles.has(id)) return void h.close();
  handles.set(id, h);
  if (fp) strips.register(id, h, fp);
  player?.reconfigure({}); // redraw with the new picture
}

function removeMedia(id: string): void {
  const h = handles.get(id);
  if (!h) return;
  handles.delete(id);
  player?.dropMedia(id);
  thumbs.dropMedia(id);
  strips.forget(id);
  player?.reconfigure({}); // closes the decode feeds first
  void h.close();
}

function startPlayer(c: PreviewConfig): void {
  const g = gpu!;
  player = new Player({
    rate: c.rate,
    size: c.size,
    endTicks: c.endTicks,
    sequence: c.sequence,
    evaluate: async (ticks, n) => (ev && cfg?.sequence ? ev.evaluate(cfg.sequence, ticks, n) : idleDescription(ticks, n)),
    stretch: (planar, rate, num, den) => (ev?.stretch ? ev.stretch(planar, rate, num, den) : planar),
    media: (id) => handles.get(id),
    upload: uploadSource,
    standIn: (id, seconds) => thumbs.nearest(id, seconds),
    strip: (id, index) => strips.picture(id, index),
    onSeek: (id, ms) => strips.noteSeek(id, ms),
    renderer: {
      render: (layers, seq) => {
        g.present(layers, seq);
        // A probe asked for the pixels: the bitmap is taken right after the present, in the same task (a canvas is cleared once it is shown).
        const want = pendingCapture;
        if (want) { pendingCapture = undefined; want(createImageBitmap(canvas!)); }
      },
      dispose: () => undefined,
    },
    audio,
    fallbackClock: { now: () => performance.now() / 1000 },
    onFrame: (f) => post({ type: "frame", frame: f }),
    onState: (playing, rate) => post({ type: "state", playing, rate }),
    onError: (message) => post({ type: "error", message }),
    raf: (cb) => {
      if (scope.requestAnimationFrame) { const id = scope.requestAnimationFrame(cb); return () => scope.cancelAnimationFrame?.(id); }
      const id = setTimeout(cb, 16);
      return () => clearTimeout(id);
    },
  });
  player.seek(0);
}

async function rpc(r: PreviewRpc): Promise<unknown> {
  switch (r.name) {
    case "stats": return { ...player?.stats, cached: player?.cached ?? 0 };
    case "position": return { frame: player?.frame ?? 0, playing: player?.isPlaying ?? false, ticks: player?.position() ?? 0 };
    case "frames": return [...handles.values()].map((h) => h.stats());
    case "strip": return strips.stats();
    case "gpu": return { info: gpu?.info, alloc: gpu?.allocStats(), canvas: backing, upload, uploadState };
    case "probe": return probe(r.x, r.y);
    case "bench": return bench(r.width, r.height, r.frames);
    case "parity": return parity(r.frame);
    case "poster": return poster();
  }
}

const POSTER_W = 320, POSTER_H = 180, POSTER_MAX = 15_000;
/**
 * The project card's poster: the frame on the canvas right now (re-presented once, in the same task as the capture), fitted into 320x180 and
 * encoded as JPEG (quality 0.7, lowered until it is under 15 KB). `null` for an all-black picture (an empty spot of the timeline: the card keeps its
 * old poster or its placeholder) or when no frame arrives within a second. Runs in this Worker, never on the UI thread.
 */
async function poster(): Promise<Blob | null> {
  if (!player || !canvas) return null;
  const bmp = await new Promise<ImageBitmap | null>((resolve) => {
    const timer = setTimeout(() => { pendingCapture = undefined; resolve(null); }, 1000);
    pendingCapture = (p) => void p.then((b) => { clearTimeout(timer); resolve(b); }, () => { clearTimeout(timer); resolve(null); });
    if (player && !player.isPlaying) player.seek(player.frame);
  });
  if (!bmp) return null;
  try {
    const c = new OffscreenCanvas(POSTER_W, POSTER_H);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.fillStyle = "#0b0b0d";
    g.fillRect(0, 0, POSTER_W, POSTER_H);
    const k = Math.min(POSTER_W / bmp.width, POSTER_H / bmp.height);
    const w = bmp.width * k, h = bmp.height * k;
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, (POSTER_W - w) / 2, (POSTER_H - h) / 2, w, h);
    const d = g.getImageData(0, 0, POSTER_W, POSTER_H).data;
    let lit = false;
    for (let i = 0; i < d.length; i += 64) if (d[i]! > 24 || d[i + 1]! > 24 || d[i + 2]! > 24) { lit = true; break; }
    if (!lit) return null;
    for (const quality of [0.7, 0.55, 0.4, 0.28]) {
      const blob = await c.convertToBlob({ type: "image/jpeg", quality });
      if (blob.size <= POSTER_MAX) return blob;
    }
    return null;
  } finally {
    bmp.close();
  }
}

/**
 * Compositor frame time (test and measurement only): three full-size RGBA layers (upload included, as for decoded CPU frames) composited at
 * `width` x `height`, handed to an encoder-style consumer two ways (the export capture modes). Headless runs use a software rasteriser: not a device number.
 */
async function bench(width: number, height: number, frames: number): Promise<unknown> {
  const px = new Uint8Array(width * height * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = i % 251; px[i + 1] = (i >> 8) % 241; px[i + 2] = 128; px[i + 3] = 255; }
  const layers: GpuLayer[] = [0, 1, 2].map((i) => ({ source: { rgba: px }, width, height, rotation: 0, center: [width / 2 + i * 20, height / 2], scale: [1 - i * 0.2, 1 - i * 0.2], angle: i * 0.1, opacity: i === 0 ? 1 : 0.6 }));
  const seq = { width, height };
  const out: Record<string, unknown> = { width, height, frames, backend: gpu?.info.backend };
  for (const mode of ["readback", "canvas"] as const) {
    const c = new OffscreenCanvas(width, height);
    const r = await openRenderer(c, gpu!.info.backend);
    r.resize(width, height);
    const t: number[] = [];
    try {
      for (let i = -3; i < frames; i++) {
        const t0 = performance.now();
        const vf = await renderExportFrame(r, c, mode, layers, seq, { timestamp: i * 33333, duration: 33333 });
        vf.close();
        if (i >= 0) t.push(performance.now() - t0);
      }
    } finally {
      r.dispose();
    }
    t.sort((a, b) => a - b);
    out[mode] = { p50: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)], mean: t.reduce((a, b) => a + b, 0) / t.length };
  }
  return out;
}

/** Random-access decode that waits out the player's own scrub requests (the handle keeps only the latest request: the older one is cancelled). Test only. */
async function still(h: MediaHandle, index: number) {
  for (let i = 0; ; i++) {
    try {
      return await h.videoFrame(index);
    } catch (e) {
      if (i > 20 || (e as { kind?: string }).kind !== "cancelled") throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** Pixels of the presented canvas (test only): the composited frame as the user sees it. */
async function capture(): Promise<ImageData> {
  const bmp = await createImageBitmap(canvas!);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, c.width, c.height);
}

let pendingCapture: ((bmp: Promise<ImageBitmap>) => void) | undefined;

/** Pixel of what the preview presents (test only): the player draws the current frame again and the canvas is read the moment it is presented. */
async function probe(x: number, y: number): Promise<number[]> {
  // Bounded: a probe runs on the message chain, so one whose draw never presents (a failed decode, a draw superseded and dropped) would hold up every
  // message behind it (media, config, the next probe) for good. After 2 s it gives up with an error and the caller asks again.
  const bmp = await new Promise<ImageBitmap>((resolve, reject) => {
    const timer = setTimeout(() => { pendingCapture = undefined; reject(new Error("the preview presented no frame within 2 s")); }, 2000);
    pendingCapture = (p) => void p.then((b) => { clearTimeout(timer); resolve(b); }, (e) => { clearTimeout(timer); reject(e); });
    if (player && !player.isPlaying) player.seek(player.frame);
  });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height);
  const i = (Math.min(d.height - 1, y) * d.width + Math.min(d.width - 1, x)) * 4;
  return [d.data[i]!, d.data[i + 1]!, d.data[i + 2]!];
}

/**
 * Preview path vs export path on one project frame (test only): the same layers go through `present` (canvas, what the user sees) and through
 * `renderExportFrame` in both modes (readback bytes, canvas snapshot, what the encoder gets). Returns the largest per-channel differences.
 */
async function parity(frame: number): Promise<unknown> {
  if (!ev || !cfg || !gpu || !canvas) throw new Error("open a project first");
  const a = cfg;
  const desc = ev.evaluate(a.sequence, frameStartTicks(frame, a.rate), 0);
  const held: { release(): void }[] = [];
  try {
    const layers: GpuLayer[] = [];
    for (const l of desc.layers) {
      const h = handles.get(l.media);
      if (!h?.info.video) continue;
      const f = await still(h, h.frameIndexAt(l.source_time));
      held.push(f);
      layers.push(layerOf(l, { source: f.kind === "gpu" ? f.frame : { rgba: f.rgba }, width: f.width, height: f.height, rotation: h.info.video.rotation }, a.size));
    }
    const times = { timestamp: 0, duration: 1 };
    gpu.present(layers, a.size);
    const shown = (await capture()).data;
    // The exporter has its own compositor on its own canvas (a worker of its own in the app); a renderer that has presented cannot read back on
    // WebGPU in Chromium, so each export mode gets a fresh one here too.
    const read = async (mode: "readback" | "canvas"): Promise<Uint8Array> => {
      const c = new OffscreenCanvas(canvas!.width, canvas!.height);
      const r = await openRenderer(c, gpu!.info.backend);
      try {
        r.resize(c.width, c.height);
        const vf = await renderExportFrame(r, c, mode, layers, a.size, times);
        const out = new Uint8Array(vf.allocationSize({ format: "RGBA" }));
        await vf.copyTo(out, { format: "RGBA" });
        vf.close();
        return out;
      } finally {
        r.dispose();
      }
    };
    const exported = await read("readback");
    const snapshot = await read("canvas");
    const maxDiff = (p: ArrayLike<number>, q: ArrayLike<number>): number => {
      let m = 0;
      for (let i = 0; i < p.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(p[i]! - q[i]!));
      return m;
    };
    return { width: canvas.width, height: canvas.height, layers: layers.length, previewVsReadback: maxDiff(shown, exported), previewVsCanvasCapture: maxDiff(shown, snapshot), lit: shown.some((v, i) => i % 4 !== 3 && v > 16) };
  } finally {
    for (const h of held) h.release();
  }
}

scope.addEventListener("message", (e) => {
  const m = e.data;
  // A reply answers a request this worker is already waiting on (upload path, audio resume, native call): resolve it at once. Queued behind
  // the chain it could deadlock: an rpc that waits for a present (probe) holds the chain while the draw it waits for needs this reply.
  if (m.type === "reply") {
    pending.get(m.id)?.(m.value);
    pending.delete(m.id);
    return;
  }
  chain = chain.then(() => handle(m)).catch((err) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
});
let chain: Promise<void> = Promise.resolve();

async function handle(m: ToPreview): Promise<void> {
  switch (m.type) {
    case "init":
      try {
        canvas = m.canvas;
        mediaApi = await openMediaApi();
        gpu = await openRenderer(m.canvas, m.prefer);
        backing = { width: m.canvas.width, height: m.canvas.height };
        post({ type: "ready", info: gpu.info });
      } catch (err) {
        post({ type: "fail", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    case "config":
      if (!gpu) return;
      await configure(m);
      return;
    case "media":
      await addMedia(m.id, m.file, m.fp);
      return;
    case "media-native":
      await addMedia(m.id, { path: m.path });
      return;
    case "unmedia":
      removeMedia(m.id);
      return;
    case "strip-config":
      strips.setCap(m.capBytes);
      strips.setEnabled(m.enabled);
      return;
    case "thumb":
      thumbs.add(m.media, m.seconds, m.bitmap, m.bitmap.width, m.bitmap.height);
      return;
    case "resize":
      if (!gpu) return;
      backing = { width: Math.max(1, Math.round(m.width)), height: Math.max(1, Math.round(m.height)) };
      gpu.resize(backing.width, backing.height);
      if (player && !player.isPlaying) player.seek(player.frame);
      return;
    case "cmd": {
      const p = player;
      if (!p) return;
      const c = m.cmd;
      if (c.name === "seek") p.seek(c.frame);
      else if (c.name === "step") p.step(c.delta);
      else if (c.name === "toggle") p.toggle();
      else if (c.name === "key") p.key(c.key);
      else if (c.name === "play") void p.play(c.rate);
      else p.pause();
      return;
    }
    case "clock":
      anchor = { audio: m.audio, epoch: m.epoch };
      return;
    case "reply": // handled in the message listener, outside the chain
      return;
    case "rpc":
      try {
        post({ type: "reply", id: m.id, value: await rpc(m.rpc) });
      } catch (err) {
        post({ type: "reply", id: m.id, value: { error: err instanceof Error ? err.message : String(err) } });
      }
      return;
    case "dispose":
      player?.dispose();
      player = undefined;
      strips.dispose();
      for (const h of handles.values()) void h.close();
      handles = new Map();
      ev?.free();
      ev = undefined;
      gpu?.dispose();
      gpu = undefined;
      return;
  }
}
