/**
 * The two end-to-end device tests (M1 exit criteria), run on the page itself because they must go through the REAL pipelines:
 * "playback" drives the preview Worker (PreviewHost: decode, compositor, player) on a hidden canvas; "exportSpeed" drives `engine.export`.
 * Both fail soft (unsupported / error / timeout with a reason) and report flat numbers like the Worker tests.
 */
import { createEngine, ExportError, type Project } from "@app/engine-client";
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
    id: hex(1), name: "device playback test", schema_version: 2,
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
    await sleep(1500); // first frame drawn: also runs the upload-path measurement once, outside the timed run
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
    const gpu = await host.rpc<{ upload?: { path: string; source: string } }>({ name: "gpu" });
    const times = s1.times.slice(s0.times.length);
    const span = times.length > 1 ? times[times.length - 1]! - times[0]! : 0;
    const late = s1.late.slice(s0.late.length).sort((a, b) => a - b);
    const presented = s1.presented - s0.presented;
    return {
      layers: 3, size: "1920x1080@30", backend: info.backend, upload_path: gpu.upload?.path ?? "n/a",
      presented, dropped: s1.dropped - s0.dropped, stalls: s1.stalls - s0.stalls,
      fps: span ? Math.round(((times.length - 1) / span) * 10) / 10 : 0,
      p95_late_ms: Math.round(late[Math.floor(late.length * 0.95)] ?? 0),
    };
  } finally {
    host?.dispose();
    canvas.remove();
  }
}

async function exportSpeed(progress: (f: number) => void): Promise<Record<string, number | string>> {
  const engine = await createEngine();
  const project = patternProject(10, { width: 1920, height: 1080, fps: [30, 1] });
  await engine.editing.open(project);
  const job = await engine.export.start({ sequence: hex(3) });
  const timer = setTimeout(() => job.cancel(), LIMIT_MS - 5_000);
  job.onProgress((p) => progress(p.fraction));
  try {
    const r = await job.result;
    await r.remove().catch(() => undefined);
    const st = r.stats;
    return { size: "1920x1080@30", seconds: 10, audio: "yes", codec: st.codecs, x_realtime: Math.round(st.speedVsRealtime * 100) / 100, encode_ms: Math.round(st.encodeMs), frames: st.frames, file_mb: Math.round((st.fileBytes / 1e6) * 10) / 10 };
  } finally {
    clearTimeout(timer);
  }
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
    const unsupported = /unsupported|not available|WebGPU|WebGL|WebCodecs|Worker/i.test(msg) || (e instanceof ExportError && e.code === "unsupported");
    return done({ status: unsupported ? "unsupported" : "error", reason: msg.slice(0, 160), metrics: {} });
  }
}
