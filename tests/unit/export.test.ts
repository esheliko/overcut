import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AudioMixer } from "../../packages/engine-client/src/export/audio-mix";
import { createTestPatternAudio } from "../../packages/engine-client/src/export/media";
import { createExportApi, exportNotYet, type WorkerLike } from "../../packages/engine-client/src/export/job";
import { AUDIO_BLOCK, outputFrameTimes, runExport, type ExportEnv } from "../../packages/engine-client/src/export/pipeline";
import { frameMicros, frameTicks, planExport, sampleMicros, sampleTicks, TICKS_PER_SECOND } from "../../packages/engine-client/src/export/plan";
import { resolvePreset, type CodecProbe } from "../../packages/engine-client/src/export/presets";
import { ExportError, type FromWorker, type ToWorker } from "../../packages/engine-client/src/export/types";
import type { ExportProgress } from "../../packages/engine-client/src/export/types";
import type { Project } from "../../packages/engine-client/src/model.generated";

const T = Number(TICKS_PER_SECOND);
function project(opts: { seconds?: number; fps?: [number, number]; rate?: number } = {}): Project {
  const [num, den] = opts.fps ?? [30, 1];
  const dur = (opts.seconds ?? 2) * T;
  return {
    id: "p",
    name: "t",
    schema_version: 1,
    media: [{ id: "m", kind: "video", name: "pattern", uri: "test:pattern" }],
    sequences: [
      {
        id: "s",
        name: "s",
        frame_rate: { num, den },
        resolution: { width: 1280, height: 720 },
        sample_rate: opts.rate ?? 48000,
        tracks: [{ id: "v", kind: "video", locked: false, muted: false, name: "V", clips: [{ id: "c", media: "m", start: 0, source_in: 0, duration: dur }] }],
      },
    ],
  };
}
const settings = { sequence: "s" };

test("plan: frame count, even size, exact ticks and microseconds (no float drift)", () => {
  const p = planExport(project({ seconds: 2 }), { sequence: "s", width: 641, height: 359 });
  assert.equal(p.totalFrames, 60);
  assert.equal(p.totalSamples, 96000);
  assert.deepEqual([p.width, p.height], [640, 358]);
  assert.equal(frameTicks(30, 30, 1), T);
  // 29.97: frame 30000 is exactly 1001 s; one frame is 23_543_520 ticks floor'd from 705_600_000 * 1001 / 30000
  assert.equal(frameTicks(30000, 30000, 1001), 1001 * T);
  assert.equal(frameMicros(30000, 30000, 1001), 1_001_000_000);
  assert.equal(sampleTicks(48000, 48000), T);
  assert.equal(sampleMicros(48000, 48000), 1_000_000);
  const { timestamp, duration } = outputFrameTimes(p, 1);
  assert.deepEqual([timestamp, duration], [33333, 33334]); // durations tile: no gap, no overlap
});

test("plan: the whole sequence is rounded up to a frame; a range and errors are explicit", () => {
  const p = project({ seconds: 2 });
  p.sequences[0]!.tracks[0]!.clips[0]!.duration = 2 * T + 1;
  assert.equal(planExport(p, settings).totalFrames, 61);
  assert.equal(planExport(project(), { sequence: "s", range: { startFrame: 10, endFrame: 40 } }).totalFrames, 30);
  const empty = project();
  empty.sequences[0]!.tracks[0]!.clips = [];
  assert.throws(() => planExport(empty, settings), (e: unknown) => e instanceof ExportError && e.code === "empty_sequence");
  assert.throws(() => planExport(project(), { sequence: "nope" }), (e: unknown) => e instanceof ExportError && e.code === "invalid_settings");
  assert.throws(() => planExport(project(), { sequence: "s", range: { startFrame: 5, endFrame: 5 } }), (e: unknown) => e instanceof ExportError && e.code === "invalid_settings");
});

const probe = (video: string[], audio: string[]): CodecProbe => ({
  video: async (c) => video.some((p) => c.codec.startsWith(p)),
  audio: async (c) => audio.includes(c.codec),
});

test("presets: the compatibility ladder (Main + constant, Baseline + software, then no H.264) and a probe that rejects a level is skipped", async () => {
  const plan = planExport(project(), settings);
  const all = probe(["avc1", "vp09", "av01"], ["mp4a.40.2", "opus"]);
  const l0 = await resolvePreset(plan, settings, all);
  const l1 = await resolvePreset(plan, { ...settings, safeLevel: 1 }, all);
  const l2 = await resolvePreset(plan, { ...settings, safeLevel: 2 }, all);
  const l3 = await resolvePreset(plan, { ...settings, safeLevel: 3 }, all);
  assert.deepEqual([l0.video.codec.slice(0, 7), l0.video.bitrateMode, l0.video.latencyMode], ["avc1.64", "variable", "quality"]);
  assert.deepEqual([l1.video.codec.slice(0, 7), l1.video.bitrateMode, l1.video.latencyMode, l1.video.hardwareAcceleration], ["avc1.4d", "constant", "realtime", "no-preference"]);
  assert.deepEqual([l2.video.codec.slice(0, 7), l2.video.hardwareAcceleration], ["avc1.42", "prefer-software"]);
  assert.deepEqual([l3.container, l3.videoCodec, l3.audioCodec], ["webm", "vp9", "opus"]);
  // A device whose probe refuses Baseline at level 2 falls through to VP9 instead of failing.
  const noBaseline: CodecProbe = { ...all, video: async (c) => !c.codec.startsWith("avc1.42") && (await all.video(c)) };
  const l2b = await resolvePreset(plan, { ...settings, safeLevel: 2 }, noBaseline);
  assert.equal(l2b.videoCodec, "vp9");
  // Asking for H.264 by name keeps it at every level.
  assert.equal((await resolvePreset(plan, { ...settings, videoCodec: "h264", safeLevel: 3 }, all)).videoCodec, "avc");
});

test("presets: ADR 0004 order, never a combination the probe rejected", async () => {
  const plan = planExport(project(), settings);
  const best = await resolvePreset(plan, settings, probe(["avc1", "vp09", "av01"], ["mp4a.40.2", "opus"]));
  assert.deepEqual([best.container, best.videoCodec, best.audioCodec, best.warnings.length], ["mp4", "avc", "aac", 0]);
  const noAac = await resolvePreset(plan, settings, probe(["avc1", "vp09"], ["opus"]));
  assert.deepEqual([noAac.container, noAac.videoCodec, noAac.audioCodec], ["mp4", "avc", "opus"]); // H.264 is the default wherever it encodes
  const h264Opus = await resolvePreset(plan, settings, probe(["avc1"], ["opus"]));
  assert.deepEqual([h264Opus.container, h264Opus.videoCodec, h264Opus.audioCodec], ["mp4", "avc", "opus"]);
  assert.match(h264Opus.warnings[0] ?? "", /Opus/);
  assert.equal(h264Opus.video.avc?.format, "avc");
  const asked = await resolvePreset(plan, { sequence: "s", container: "webm", videoCodec: "av1" }, probe(["av01", "avc1"], ["opus"]));
  assert.deepEqual([asked.container, asked.videoCodec], ["webm", "av1"]);
  await assert.rejects(resolvePreset(plan, { sequence: "s", container: "webm", videoCodec: "h264" }, probe(["avc1"], ["opus"])), (e: unknown) => e instanceof ExportError && e.code === "unsupported");
  await assert.rejects(resolvePreset(plan, settings, probe([], [])), (e: unknown) => e instanceof ExportError && /cannot encode/.test(e.message));
});

test("mixer: places a segment at its offset and applies gain; silence elsewhere", async () => {
  const media = {
    read: async (_start: number, count: number, out: Float32Array[]) => {
      for (const ch of out) ch.fill(0.5, 0, count);
    },
    close: () => undefined,
  };
  const mixer = new AudioMixer(48000, async () => media);
  const seg = { track: "a", clip: "c", media: "m", out_start: 2, len: 4, source_start: 100 * 14700, speed: { num: 1, den: 1 }, gain: 0.5 };
  const out = new Float32Array(16);
  await mixer.mix({ time: 0, frame: 0, video_time: 0, sample: 0, audio_samples: 8, layers: [], audio: [seg] }, 8, out);
  assert.deepEqual(Array.from(out.subarray(0, 8)), [0, 0, 0.25, 0.25, 0.25, 0.25, 0, 0]);
  assert.deepEqual(Array.from(out.subarray(8, 16)), [0, 0, 0.25, 0.25, 0.25, 0.25, 0, 0], "both channels");
});

test("mixer: values above 1 clamp, speed 2 reads every second source sample", async () => {
  const media = {
    read: async (start: number, count: number, out: Float32Array[]) => {
      for (const ch of out) for (let i = 0; i < count; i++) ch[i] = (start + i) / 100;
    },
    close: () => undefined,
  };
  const mixer = new AudioMixer(48000, async () => media);
  const out = new Float32Array(8);
  await mixer.mix({ time: 0, frame: 0, video_time: 0, sample: 0, audio_samples: 4, layers: [], audio: [{ track: "a", clip: "c", media: "m", out_start: 0, len: 4, source_start: 10 * 14700, speed: { num: 2, den: 1 }, gain: 1 }] }, 4, out);
  assert.deepEqual(Array.from(out.subarray(0, 4)).map((v) => Math.round(v * 100)), [10, 12, 14, 16]);
  const loud = new Float32Array(8);
  await mixer.mix({ time: 0, frame: 0, video_time: 0, sample: 0, audio_samples: 4, layers: [], audio: [{ track: "a", clip: "c", media: "m", out_start: 0, len: 4, source_start: 500 * 14700, speed: { num: 1, den: 1 }, gain: 1 }] }, 4, loud);
  assert.equal(loud[0], 1);
});

/** A fake platform: records what the real encoders and muxer would receive and "encodes" it into a hash, so determinism is checkable. */
function fakeEnv(plan: ReturnType<typeof planExport>, over: { signal?: AbortController; failAt?: number; clock?: () => number } = {}) {
  const log: string[] = [];
  const hash = createHash("sha256");
  const audioRanges: Array<[number, number]> = [];
  const flashes: number[] = [];
  const audioClicks: number[] = [];
  let frameNo = 0;
  let queue = 0;
  let maxQueue = 0;
  let aborted = 0;
  let live = 0;
  let lastNonZero = -1000;
  const pattern = createTestPatternAudio(plan.sampleRate);
  let clock = 0;
  const env: ExportEnv<{ close(): void; id: number }> = {
    plan,
    evaluate: (ticks, n) => ({
      time: ticks,
      frame: 0,
      video_time: ticks,
      sample: 0,
      audio_samples: n,
      layers: [{ track: "v", clip: "c", media: "m", source_time: ticks, transform: { center: [0, 0], scale: [1, 1], rotation: 0 }, opacity: 1 }],
      audio: n ? [{ track: "a", clip: "c", media: "m", out_start: 0, len: n, source_start: ticks, speed: { num: 1, den: 1 }, gain: 1 }] : [],
    }),
    render: async (desc, index) => {
      if (over.failAt === index) throw new ExportError("encode_failed", "boom");
      live++;
      return { id: index, ticks: desc.time, close: () => void live-- } as { close(): void; id: number };
    },
    mix: (desc, frames, out) => new AudioMixer(plan.sampleRate, async () => pattern).mix(desc, frames, out),
    video: {
      encode: (f, key) => {
        queue++;
        maxQueue = Math.max(maxQueue, queue);
        const t = outputFrameTimes(plan, f.id).timestamp;
        hash.update(`V${f.id}:${t}:${key}:${(f as unknown as { ticks: number }).ticks};`);
        // the pattern media flashes on source frame 0, 30, 60... (30 fps media, floor of source time)
        const ticks = (f as unknown as { ticks: number }).ticks;
        const src = Number((BigInt(ticks) * 30n) / TICKS_PER_SECOND);
        const prev = Number((BigInt(Math.max(0, ticks - Math.round(T / (plan.fpsNum / plan.fpsDen)))) * 30n) / TICKS_PER_SECOND);
        if (src % 30 === 0 && (f.id === 0 || prev !== src)) flashes.push(t);
        frameNo++;
        if (over.signal && frameNo === 10) over.signal.abort();
      },
      ready: async () => void (queue = 0),
      flush: async () => void log.push("flush-video"),
    },
    audio: {
      encode: (planar, frames, start) => {
        audioRanges.push([start, frames]);
        hash.update(`A${start}:${frames}:`).update(Buffer.from(planar.buffer, planar.byteOffset, planar.byteLength));
        // a click onset is the first non-zero sample after >= 100 samples of silence (the click's own first sample is exactly 0, so onset = start + 1)
        for (let i = 0; i < frames; i++) {
          if ((planar[i] ?? 0) === 0) continue;
          if (start + i - lastNonZero > 100) audioClicks.push(sampleMicros(start + i, plan.sampleRate));
          lastNonZero = start + i;
        }
      },
      ready: async () => undefined,
      flush: async () => void log.push("flush-audio"),
    },
    finish: async () => (log.push("finish"), { fileBytes: 123 }),
    abort: async () => void aborted++,
    now: over.clock ?? (() => (clock += 40)),
    peakQueue: () => maxQueue,
  };
  return { env, log, digest: () => hash.digest("hex"), audioRanges, flashes, audioClicks, state: () => ({ maxQueue, aborted, live, frameNo }) };
}

test("pipeline: every frame and every audio sample exactly once, in order, then flush, then finish", async () => {
  const plan = planExport(project({ seconds: 3 }), settings);
  const f = fakeEnv(plan);
  const progress: ExportProgress[] = [];
  const r = await runExport(f.env, new AbortController().signal, (p) => progress.push(p));
  assert.equal(r.frames, 90);
  assert.equal(r.fileBytes, 123);
  assert.deepEqual(f.log, ["flush-video", "flush-audio", "finish"]);
  // audio tiles the whole timeline: contiguous, total = plan, blocks <= AUDIO_BLOCK
  let next = 0;
  for (const [start, n] of f.audioRanges) {
    assert.equal(start, next);
    assert.ok(n > 0 && n <= AUDIO_BLOCK);
    next += n;
  }
  assert.equal(next, plan.totalSamples);
  assert.equal(f.state().live, 0, "every rendered frame was closed");
  // progress: monotonic, ends at 1 with a finalizing event, never reports ETA before 1 s
  assert.ok(progress.length >= 3);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i]!.framesDone >= progress[i - 1]!.framesDone);
  assert.equal(progress.at(-1)?.phase, "finalizing");
  assert.equal(progress.at(-1)?.fraction, 1);
  assert.equal(progress.find((p) => p.elapsedMs < 1000)?.etaMs, null);
  const mid = progress.find((p) => p.elapsedMs > 1500 && p.phase === "encoding");
  assert.ok(mid && mid.etaMs !== null && mid.etaMs >= 0 && mid.fps > 0);
  assert.equal(r.peakEncodeQueue, f.state().maxQueue);
});

test("pipeline: deterministic (the same project gives the same encoder input, byte for byte, twice)", async () => {
  const plan = planExport(project({ seconds: 2, fps: [30000, 1001] }), settings);
  const a = fakeEnv(plan);
  const b = fakeEnv(plan);
  await runExport(a.env, new AbortController().signal, () => undefined);
  await runExport(b.env, new AbortController().signal, () => undefined);
  assert.equal(a.digest(), b.digest());
});

test("pipeline sync: each flash frame and the click on the audio start at the same microsecond (S3 fixture, 30 and 29.97 fps)", async () => {
  for (const fps of [[30, 1], [30000, 1001], [25, 1]] as Array<[number, number]>) {
    const plan = planExport(project({ seconds: 4, fps }), settings);
    const f = fakeEnv(plan);
    await runExport(f.env, new AbortController().signal, () => undefined);
    assert.ok(f.flashes.length >= 4 && f.audioClicks.length >= 4, "found the flashes and the clicks");
    const frameUs = 1_000_000 / (fps[0] / fps[1]);
    for (const t of f.flashes.slice(0, 4)) {
      const nearest = Math.min(...f.audioClicks.map((c) => Math.abs(c - t)));
      assert.ok(nearest < frameUs, `flash at ${t} us is within one frame of a click (fps ${fps.join("/")}): ${nearest} us`);
      if (fps[1] === 1) assert.ok(nearest < 25, `on an integer frame rate they are the same sample (${nearest} us, detector bias is one sample)`);
    }
  }
});

test("pipeline: cancel stops promptly, aborts the platform, throws 'cancelled', and encodes nothing more", async () => {
  const plan = planExport(project({ seconds: 5 }), settings);
  const ctl = new AbortController();
  const f = fakeEnv(plan, { signal: ctl });
  await assert.rejects(runExport(f.env, ctl.signal, () => undefined), (e: unknown) => e instanceof ExportError && e.code === "cancelled");
  assert.deepEqual(f.log, [], "no flush, no finish after a cancel");
  const s = f.state();
  assert.equal(s.aborted, 1);
  assert.ok(s.frameNo <= 11, `stopped within a frame of the cancel (encoded ${s.frameNo})`);
  assert.equal(s.live, 0);
});

test("pipeline: an error in a stage aborts the platform and surfaces unchanged", async () => {
  const plan = planExport(project({ seconds: 2 }), settings);
  const f = fakeEnv(plan, { failAt: 7 });
  await assert.rejects(runExport(f.env, new AbortController().signal, () => undefined), (e: unknown) => e instanceof ExportError && e.code === "encode_failed" && e.message === "boom");
  assert.equal(f.state().aborted, 1);
});

test("pipeline: a range exports only those frames with the audio of those frames", async () => {
  const plan = planExport(project({ seconds: 4 }), { sequence: "s", range: { startFrame: 30, endFrame: 60 } });
  const f = fakeEnv(plan);
  await runExport(f.env, new AbortController().signal, () => undefined);
  assert.equal(f.state().frameNo, 30);
  assert.equal(f.audioRanges.reduce((n, [, c]) => n + c, 0), 48000);
  // the second starts at 1 s of source: the first click is at output sample 0
  assert.ok(Math.abs(f.audioClicks[0] ?? 1e9) < 25, "the first click is at the very start of the range");
});

// ---- host side: Engine.export.start over a worker ----

class LoopbackWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  terminated = false;
  received: ToWorker[] = [];
  constructor(private readonly script: (w: LoopbackWorker, m: ToWorker) => void) {}
  postMessage(m: ToWorker): void {
    this.received.push(m);
    setTimeout(() => this.script(this, m), 0);
  }
  send(m: FromWorker): void {
    this.onmessage?.({ data: m });
  }
  terminate(): void {
    this.terminated = true;
  }
}
const stats = { frames: 60, durationSeconds: 2, fileBytes: 10, encodeMs: 100, speedVsRealtime: 20, peakEncodeQueue: 2, codecs: "x" };
const storage = (log: string[]) => ({
  create: async () => {
    throw new Error("unused");
  },
  open: async (p: string) => (log.push(`open ${p}`), new File(["abc"], "x.mp4")),
  remove: async (p: string) => void log.push(`remove ${p}`),
});

test("job: progress events reach listeners, the result hands out the file and can delete it, the worker is terminated", async () => {
  const log: string[] = [];
  const w = new LoopbackWorker((w, m) => {
    if (m.type !== "start") return;
    w.send({ type: "progress", jobId: m.jobId, progress: { framesDone: 1, totalFrames: 60, fraction: 1 / 60, elapsedMs: 5, etaMs: null, fps: 0, phase: "encoding" } });
    w.send({ type: "done", jobId: m.jobId, mime: "video/mp4", path: "overcut-exports/a.mp4", fileName: "a.mp4", fileBytes: 10, stats, warnings: ["w"] });
  });
  const api = createExportApi({ spawn: () => w, project: async () => project(), storage: storage(log) });
  const job = await api.start(settings);
  const seen: number[] = [];
  const off = job.onProgress((p) => seen.push(p.framesDone));
  const res = await job.result;
  off();
  assert.deepEqual(seen, [1]);
  assert.equal(res.mime, "video/mp4");
  assert.deepEqual(res.warnings, ["w"]);
  assert.equal((await res.file()).size, 3);
  await res.remove();
  assert.deepEqual(log, ["open overcut-exports/a.mp4", "remove overcut-exports/a.mp4"]);
  assert.equal(w.terminated, true);
  assert.equal(w.received[0]?.type, "start");
});

test("job: invalid settings fail on the calling thread before any worker exists", async () => {
  let spawned = 0;
  const api = createExportApi({ spawn: () => (spawned++, new LoopbackWorker(() => undefined)), project: async () => project(), storage: storage([]) });
  await assert.rejects(api.start({ sequence: "missing" }), (e: unknown) => e instanceof ExportError && e.code === "invalid_settings");
  assert.equal(spawned, 0);
});

test("job: cancel tells the worker, and the worker's 'cancelled' error rejects the result with the typed code", async () => {
  const w = new LoopbackWorker((w, m) => {
    if (m.type === "cancel") w.send({ type: "error", jobId: m.jobId, code: "cancelled", message: "The export was cancelled." });
  });
  const api = createExportApi({ spawn: () => w, project: async () => project(), storage: storage([]) });
  const job = await api.start(settings);
  job.cancel();
  job.cancel(); // idempotent
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "cancelled");
  assert.equal(w.received.filter((m) => m.type === "cancel").length, 1);
  assert.equal(w.terminated, true);
});

test("job: a worker that never answers a cancel is terminated after the grace period and its file removed", async () => {
  const log: string[] = [];
  const w = new LoopbackWorker(() => undefined);
  const api = createExportApi({ spawn: () => w, project: async () => project(), storage: storage(log), cancelGraceMs: 10 });
  const job = await api.start(settings);
  job.cancel();
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "cancelled");
  assert.equal(w.terminated, true);
  assert.ok(log.some((l) => l.startsWith("remove overcut-exports/")));
});

test("job: a crashed worker is a typed error, not a hang; the host retries with safer settings, then reports every attempt", async () => {
  const levels: Array<number | undefined> = [];
  const workers: LoopbackWorker[] = [];
  const spawn = (): LoopbackWorker => {
    const w = new LoopbackWorker((w, m) => {
      if (m.type !== "start") return;
      levels.push(m.settings.safeLevel);
      w.send({ type: "stage", jobId: m.jobId, stage: "renderer" });
      w.onerror?.({ message: "oom", filename: "https://x/assets/export-worker-abc.js", lineno: 7, colno: 3 });
    });
    workers.push(w);
    return w;
  };
  const api = createExportApi({ spawn, project: async () => project(), storage: storage([]), crashGraceMs: 1 });
  const job = await api.start(settings);
  await assert.rejects(job.result, (e: unknown) => {
    assert.ok(e instanceof ExportError);
    assert.equal(e.code, "encode_failed");
    assert.match(e.message, /oom/);
    assert.match(e.message, /renderer/);
    assert.equal(e.detail?.stage, "renderer");
    assert.equal(e.detail?.lineno, 7);
    assert.equal(e.detail?.level, 3);
    assert.equal(e.detail?.attempts?.length, 3, "levels 0, 1, 2 failed before the last one");
    return true;
  });
  assert.deepEqual(levels, [undefined, 1, 2, 3]);
  assert.ok(workers.every((w) => w.terminated));
});

test("job: an encoder failure at level 0 is retried at level 1 and the file is delivered with a compatibility note", async () => {
  const w0 = (w: LoopbackWorker, m: ToWorker): void => {
    if (m.type !== "start") return;
    if (m.settings.safeLevel === 1) w.send({ type: "done", jobId: m.jobId, mime: "video/mp4", path: "p.mp4", fileName: "p.mp4", fileBytes: 3, stats, warnings: [] });
    else w.send({ type: "error", jobId: m.jobId, code: "encode_failed", message: "Encoding failed: EncodingError", detail: { stage: "encoding", video: "avc1.640028 1920x1080", message: "EncodingError" } });
  };
  const api = createExportApi({ spawn: () => new LoopbackWorker(w0), project: async () => project(), storage: storage([]) });
  const job = await api.start(settings);
  const r = await job.result;
  assert.equal(r.stats.safeLevel, 1);
  assert.equal(r.stats.failedAttempts?.length, 1);
  assert.equal(r.stats.failedAttempts?.[0]?.video, "avc1.640028 1920x1080");
  assert.ok(r.warnings.some((x) => /compatibility/.test(x)));
});

test("job: unreadable media is not retried (it would fail the same way)", async () => {
  let spawned = 0;
  const api = createExportApi({
    spawn: () => (spawned++, new LoopbackWorker((w, m) => m.type === "start" && w.send({ type: "error", jobId: m.jobId, code: "media_unavailable", message: "nope" }))),
    project: async () => project(),
    storage: storage([]),
  });
  const job = await api.start(settings);
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && e.code === "media_unavailable");
  assert.equal(spawned, 1);
});

test("job: a worker that goes silent is taken down after the stall limit and retried", async () => {
  let spawned = 0;
  const api = createExportApi({ spawn: () => (spawned++, new LoopbackWorker(() => undefined)), project: async () => project(), storage: storage([]), stallMs: 20 });
  const job = await api.start(settings);
  await assert.rejects(job.result, (e: unknown) => e instanceof ExportError && /stopped responding/.test(e.message) && e.detail?.stage === "starting");
  assert.equal(spawned, 4);
});

test("Tauri backend: export is a typed 'not yet' until native encoding exists", async () => {
  await assert.rejects(exportNotYet.start(settings), (e: unknown) => e instanceof ExportError && e.code === "not_yet");
});

// ---- the production decoder adapter ----
import { openBlobMedia } from "../../packages/engine-client/src/export/blob-media";
import type { MediaApi, MediaHandle } from "../../packages/engine-client/src/types";

function fakeMedia(over: { fps?: { num: number; den: number }; vfr?: boolean; packets?: number; channels?: number; pts?: number[] } = {}) {
  const asked: number[] = [];
  let released = 0;
  let closed = 0;
  const handle = {
    info: { container: "x", durationTicks: 0, video: { codec: "vp9", width: 160, height: 120, rotation: 90, sampleRate: 0, channels: 0, durationTicks: 0, packets: over.packets ?? 30, fps: over.fps ?? { num: 30, den: 1 }, vfr: over.vfr ?? false }, audio: { codec: "opus", width: 0, height: 0, rotation: 0, sampleRate: 48000, channels: over.channels ?? 1, durationTicks: 0, packets: 1, vfr: false } },
    frameKind: "gpu",
    audioRate: 48000,
    frameIndexAt: (ticks: number) => over.pts ? over.pts.filter((p) => p <= ticks).length - 1 : 0,
    videoFrame: async (i: number) => (asked.push(i), { kind: "gpu", index: i, ptsTicks: 0, width: 160, height: 120, frame: {} as VideoFrame, release: () => void released++ }),
    audio: async (_s: number, n: number) => Float32Array.from({ length: n * (over.channels ?? 1) }, (_, i) => i + 1),
    stats: () => ({ received: 0, closed: 0, open: 0 }),
    close: async () => void closed++,
  } as unknown as MediaHandle;
  const api: MediaApi = { open: async () => handle };
  return { api, asked, counts: () => ({ released, closed }) };
}

test("decoder adapter: ticks map to the media's own frame (floor), repeat without a second decode, clamp at the end, release the previous frame", async () => {
  const m = fakeMedia({ fps: { num: 24, den: 1 }, packets: 48 });
  const opened = await openBlobMedia(m.api, new Blob(["x"]), 48000, "clip");
  const at = (s: number) => Math.round(s * T);
  const f1 = await opened.video!.frame(at(1)); // frame 24
  assert.equal(f1.rotation, 90);
  await opened.video!.frame(at(1) + 5); // same frame: no new decode
  await opened.video!.frame(at(1 + 1 / 24) + 1); // frame 25
  await opened.video!.frame(at(100)); // clamps to the last frame (47)
  assert.deepEqual(m.asked, [24, 25, 47]);
  assert.equal(m.counts().released, 2, "each replaced frame was released once");
  opened.video!.close();
  opened.audio!.close();
  assert.deepEqual(m.counts(), { released: 3, closed: 1 });
});

test("decoder adapter: sequential export decodes through one stream (each picture once), skips frames it does not need, restarts for a backward or far jump, and falls back when streaming fails", async () => {
  const m = fakeMedia({ fps: { num: 30, den: 1 }, packets: 600 });
  const h = (await m.api.open(new Blob(["x"]))) as unknown as MediaHandle & { stream?: unknown };
  const starts: number[] = [];
  let streamReleased = 0;
  let fail = false;
  h.stream = (start: number) => {
    starts.push(start);
    let i = start;
    return {
      next: async () => { if (fail) throw new Error("no stream"); return { kind: "gpu", index: i++, ptsTicks: 0, width: 160, height: 120, frame: {} as VideoFrame, release: () => void streamReleased++ }; },
      buffered: () => 0,
      close: () => undefined,
    };
  };
  const opened = await openBlobMedia({ open: async () => h } as MediaApi, new Blob(["x"]), 48000, "clip");
  const at = (frame: number) => Math.round((frame / 30) * T);
  for (const f of [0, 1, 2, 4, 5]) await opened.video!.frame(at(f)); // frame 3 is skipped (a speed-up): pulled and released
  assert.deepEqual(starts, [0], "one stream for the whole forward run");
  assert.deepEqual(m.asked, [], "no random-access decode");
  assert.equal(streamReleased, 5, "skipped and replaced frames are released (the last one is still held)");
  await opened.video!.frame(at(400)); // far ahead: restart there instead of decoding 400 frames
  assert.deepEqual(starts, [0, 400]);
  await opened.video!.frame(at(10)); // backward: random access, the stream is left alone
  assert.deepEqual(m.asked, [10]);
  fail = true;
  await opened.video!.frame(at(401)); // stream breaks: this and every later frame use random access
  await opened.video!.frame(at(402));
  assert.deepEqual(m.asked, [10, 401, 402]);
});

test("decoder adapter: mono audio fills both channels, stereo deinterleaves", async () => {
  const mono = await openBlobMedia(fakeMedia({ channels: 1 }).api, new Blob(["x"]), 48000, "m");
  const out = [new Float32Array(3), new Float32Array(3)];
  await mono.audio!.read(0, 3, out);
  assert.deepEqual([Array.from(out[0]!), Array.from(out[1]!)], [[1, 2, 3], [1, 2, 3]]);
  const st = await openBlobMedia(fakeMedia({ channels: 2 }).api, new Blob(["x"]), 48000, "s");
  await st.audio!.read(0, 3, out);
  assert.deepEqual([Array.from(out[0]!), Array.from(out[1]!)], [[1, 3, 5], [2, 4, 6]]);
});

test("decoder adapter: a variable-frame-rate clip exports at its real speed (frame chosen from its own timestamps, not a constant rate)", async () => {
  // frames at 0, 0.1 s, 0.15 s, 0.5 s: no constant rate describes this
  const pts = [0, 0.1, 0.15, 0.5].map((s) => Math.round(s * T));
  const m = fakeMedia({ vfr: true, packets: 4, fps: { num: 0, den: 1 }, pts });
  const opened = await openBlobMedia(m.api, new Blob(["x"]), 48000, "phone.mp4");
  for (const s of [0, 0.05, 0.1, 0.12, 0.2, 0.49, 0.5, 9]) await opened.video!.frame(Math.round(s * T));
  assert.deepEqual(m.asked, [0, 1, 2, 3], "each distinct picture is decoded once, the last one holds");
});
