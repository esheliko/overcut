/**
 * The two end-to-end device tests (M1 exit criteria), run on the page itself because they must go through the REAL pipelines:
 * "playback" drives the preview Worker (PreviewHost: decode, compositor, player) on a hidden canvas; "exportSpeed" drives `engine.export`.
 * Both fail soft (unsupported / error / timeout with a reason) and report flat numbers like the Worker tests.
 */
import { createEngine, ExportError, type ExportFailureDetail, type Project } from "@app/engine-client";
import { patternProject } from "../ExportHarness";
import { PreviewHost } from "../preview/host";
import { TICKS_PER_SECOND } from "../preview/timing";
import type { TestId, TestResult } from "./types";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT_MS = 90_000;

/** 3 stacked 1080p30 video tracks of the shipped 5 s test clip (the S1 spike clip), the whole sequence 5 s. */
function layeredProject(seconds: number): Project {
  const clip = (n: number) => ({ id: hex(10 + n), media: hex(2), start: 0, source_in: 0, duration: seconds * TICKS_PER_SECOND });
  return {
    id: hex(1), name: "device playback test", schema_version: 4,
    media: [{ id: hex(2), kind: "video", name: "clip-gop30.mp4", uri: "file:clip-gop30.mp4" }],
    sequences: [{
      id: hex(3), name: "main", frame_rate: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sample_rate: 48000,
      tracks: [0, 1, 2].map((i) => ({ id: hex(4 + i), kind: "video", locked: false, muted: false, name: `V${i + 1}`, clips: [clip(i)] })),
    }],
  } as unknown as Project;
}

async function playback(progress: (f: number) => void): Promise<Record<string, number | string>> {
  const SECONDS = 5;
  const res = await fetch(new URL("/diagnostics/clip-gop30.mp4", location.origin));
  if (!res.ok) throw new Error(`clip-gop30.mp4: HTTP ${res.status}`);
  const file = new File([await res.arrayBuffer()], "clip-gop30.mp4", { type: "video/mp4" });
  const canvas = document.createElement("canvas");
  canvas.width = 960; canvas.height = 540;
  canvas.style.cssText = "position:fixed;left:-9999px;top:0;width:960px;height:540px";
  document.body.appendChild(canvas);
  let host: PreviewHost | null = null;
  try {
    host = new PreviewHost(canvas, { onFrame: () => undefined, onState: () => undefined, onError: () => undefined });
    const info = await Promise.race([host.ready, sleep(15_000).then(() => { throw new Error("the preview did not start in 15 s"); })]);
    host.resize(960, 540);
    host.send({ type: "media", id: hex(2), file });
    host.configure({ project: JSON.stringify(layeredProject(SECONDS)), sequence: hex(3), rate: { num: 30, den: 1 }, size: { width: 1920, height: 1080 }, endTicks: SECONDS * TICKS_PER_SECOND });
    for (let i = 0; i < 150 && ((await host.rpc<unknown[]>({ name: "frames" })).length === 0); i++) await sleep(100);
    if ((await host.rpc<unknown[]>({ name: "frames" })).length === 0) throw new Error("the test clip could not be opened by the decoder");
    host.player.seek(0);
    // First frame drawn: the preview measures its upload path once the player is idle (about 1 to 3 s on a phone); wait for it so it is not inside the timed run.
    for (let i = 0; i < 100 && !(await host.rpc<{ upload?: unknown }>({ name: "gpu" })).upload; i++) await sleep(100);
    await sleep(500);
    type S = { presented: number; dropped: number; stalls: number; late: number[]; times: number[] };
    const s0 = await host.rpc<S>({ name: "stats" });
    const t0 = performance.now();
    host.player.toggle();
    while (performance.now() - t0 < (SECONDS + 1) * 1000) {
      progress(Math.min(1, (performance.now() - t0) / (SECONDS * 1000)));
      await sleep(200);
      if (performance.now() - t0 > 1000 && !host.player.isPlaying) break; // reached the end
    }
    host.player.toggle();
    const s1 = await host.rpc<S>({ name: "stats" });
    const gpu = await host.rpc<{ upload?: { path: string; source: string; ms?: Record<string, number> }; uploadState?: string }>({ name: "gpu" });
    const times = s1.times.slice(s0.times.length);
    const span = times.length > 1 ? times[times.length - 1]! - times[0]! : 0;
    const late = s1.late.slice(s0.late.length).sort((a, b) => a - b);
    const presented = s1.presented - s0.presented;
    return {
      layers: 3, size: "1920x1080@30", backend: info.backend, upload_path: gpu.upload?.path ?? "n/a", upload_source: gpu.upload?.source ?? "n/a", upload_state: gpu.uploadState ?? "n/a", upload_ms_frame: round1(gpu.upload?.ms?.frame), upload_ms_cpu: round1(gpu.upload?.ms?.cpu),
      presented, dropped: s1.dropped - s0.dropped, stalls: s1.stalls - s0.stalls,
      fps: span ? Math.round(((times.length - 1) / span) * 10) / 10 : 0,
      p95_late_ms: Math.round(late[Math.floor(late.length * 0.95)] ?? 0),
    };
  } finally {
    host?.dispose();
    canvas.remove();
  }
}

/** One export through `engine.export`, flat numbers. `real` = the shipped clip through the production decoder; otherwise the synthetic test pattern. */
async function exportOnce(engine: Awaited<ReturnType<typeof createEngine>>, real: File | null, progress: (f: number) => void): Promise<Record<string, number | string>> {
  const project = real
    ? ({
        id: hex(1), name: "device export test", schema_version: 4,
        media: [{ id: hex(2), kind: "video", name: real.name, uri: `file:${real.name}` }],
        sequences: [{ id: hex(3), name: "main", frame_rate: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sample_rate: 48000, tracks: [{ id: hex(4), kind: "video", locked: false, muted: false, name: "V1", clips: [{ id: hex(10), media: hex(2), start: 0, source_in: 0, duration: 5 * TICKS_PER_SECOND }] }] }],
      } as unknown as Project)
    : patternProject(10, { width: 1920, height: 1080, fps: [30, 1] });
  await engine.editing.open(project);
  const job = await engine.export.start({ sequence: hex(3), ...(real ? { sources: { [hex(2)]: real } } : {}) });
  const timer = setTimeout(() => job.cancel(), LIMIT_MS - 5_000);
  job.onProgress((p) => progress(p.fraction));
  try {
    const r = await job.result;
    await r.remove().catch(() => undefined);
    const st = r.stats;
    const t = st.timingMs ?? {};
    return {
      size: "1920x1080@30", seconds: Math.round(st.durationSeconds), source: real ? "clip" : "synthetic", codec: st.codecs, capture: st.capture ?? "n/a",
      x_realtime: Math.round(st.speedVsRealtime * 100) / 100, encode_ms: Math.round(st.encodeMs), frames: st.frames, file_mb: Math.round((st.fileBytes / 1e6) * 10) / 10,
      // Where the time goes per frame (ms): decode + composite are parts of render; wait = the encoder is the bottleneck.
      ms_per_frame: Math.round(st.encodeMs / Math.max(1, st.frames)),
      ms_decode: perFrame(t.decode, st.frames), ms_composite: perFrame(t.composite, st.frames), ms_render: perFrame(t.render, st.frames), ms_encode_call: perFrame(t.encode, st.frames),
      ms_audio: perFrame(t.audio, st.frames), ms_wait: perFrame(t.wait, st.frames), ms_evaluate: perFrame(t.evaluate, st.frames),
      safe_level: st.safeLevel ?? 0, ...(st.failedAttempts?.length ? failureMetrics(undefined, st.failedAttempts) : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
const perFrame = (total: number | undefined, frames: number): number => (typeof total === "number" ? Math.round((total / Math.max(1, frames)) * 10) / 10 : -1);

/**
 * Export speed. The headline numbers (`x_realtime`...) are the shipped 1080p30 clip (5 s) through the production decoder, compositor and encoder, the
 * path a real export takes. When time allows, the synthetic 10 s test pattern (the M1 test; its scene generator is a CPU canvas read back per frame,
 * so it measures that more than the device) follows as `synthetic_*`.
 */
async function exportSpeed(progress: (f: number) => void): Promise<Record<string, number | string>> {
  const engine = await createEngine();
  const res = await fetch(new URL("/diagnostics/clip-gop30.mp4", location.origin)).catch(() => null);
  const real = res?.ok ? new File([await res.arrayBuffer()], "clip-gop30.mp4", { type: "video/mp4" }) : null;
  const main = await exportOnce(engine, real, (f) => progress(real ? f * 0.5 : f));
  if (!real) return main;
  const out: Record<string, number | string> = { ...main };
  if (typeof main.encode_ms === "number" && main.encode_ms * 2.5 < LIMIT_MS - 20_000) {
    try {
      const syn = await exportOnce(engine, null, (f) => progress(0.5 + f * 0.5));
      for (const k of ["x_realtime", "ms_per_frame", "ms_render", "ms_composite", "ms_wait"]) if (syn[k] !== undefined) out[`synthetic_${k}`] = syn[k]!;
    } catch (e) {
      out.synthetic_error = (e instanceof Error ? e.message : String(e)).slice(0, 80);
    }
  }
  return out;
}

const round1 = (v: number | undefined): number => (typeof v === "number" ? Math.round(v * 10) / 10 : -1);
const clip = (v: string | undefined, n: number): string => (v ?? "").replace(/\s+/g, " ").slice(0, n);

/** The failure of an export, flat and short enough for the copied report: where it died, what the browser said, which encoder config was tried. */
export function failureMetrics(e: ExportError | undefined, attempts: ExportFailureDetail[] = e?.detail?.attempts ?? []): Record<string, number | string> {
  const m: Record<string, number | string> = {};
  const d = e?.detail;
  if (e) {
    m.error_code = e.code;
    if (d?.stage) m.stage = d.stage;
    if (d?.frames !== undefined) m.frames_done = d.frames;
    if (d?.level !== undefined) m.safe_level = d.level;
    if (d?.name) m.err_name = d.name;
    if (d?.message) m.err_msg = clip(d.message, 200);
    if (d?.filename) m.err_file = clip(d.filename.split("/").slice(-2).join("/"), 80);
    if (d?.lineno !== undefined) m.err_line = `${d.lineno}:${d.colno ?? 0}`;
    if (d?.stack) m.err_stack = clip(d.stack, 400);
    if (d?.video) m.video_cfg = d.video;
    if (d?.audio) m.audio_cfg = d.audio;
  }
  m.attempts = attempts.length + (e ? 1 : 0);
  attempts.slice(0, 4).forEach((a, i) => {
    m[`attempt${i + 1}`] = clip(`L${a.level ?? 0} stage=${a.stage ?? "?"} frames=${a.frames ?? 0} ${a.video ?? ""} | ${a.name ? `${a.name}: ` : ""}${a.message ?? ""}${a.filename ? ` @${a.filename.split("/").pop()}:${a.lineno ?? 0}` : ""}`, 300);
  });
  return m;
}

export const PIPELINE_TESTS: readonly TestId[] = ["playback", "exportSpeed"];

/** Run one of the page-level tests; never throws. */
export async function runPipelineTest(id: TestId, progress: (f: number) => void): Promise<TestResult> {
  const t0 = performance.now();
  const done = (r: Omit<TestResult, "id" | "took_ms">): TestResult => ({ id, took_ms: Math.round(performance.now() - t0), ...r });
  try {
    const work = id === "playback" ? playback(progress) : exportSpeed(progress);
    const metrics = await Promise.race([work, sleep(LIMIT_MS).then(() => { throw new Error("__timeout"); })]);
    return done({ status: "ok", metrics });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "__timeout") return done({ status: "timeout", metrics: {} });
    // A crashed or failed export is an error with its cause attached, never "unsupported": only "this device cannot do it at all" is.
    const unsupported = e instanceof ExportError ? e.code === "unsupported" : /unsupported|not available|WebGPU|WebGL|WebCodecs|Worker/i.test(msg);
    return done({ status: unsupported ? "unsupported" : "error", reason: msg.slice(0, 160), metrics: e instanceof ExportError ? failureMetrics(e) : {} });
  }
}
