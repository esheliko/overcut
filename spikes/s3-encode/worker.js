// S3 spike worker: synthetic scene -> WebCodecs VideoEncoder/AudioEncoder -> mp4-muxer / webm-muxer.
// Scene: dark background, moving bar, frame counter; every FLASH_EVERY frames (once per second) one
// all-white frame. Audio: silence + a 3 ms 2 kHz click starting at the exact same instant as the flash frame.
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "./node_modules/mp4-muxer/build/mp4-muxer.mjs";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "./node_modules/webm-muxer/build/webm-muxer.mjs";

const SR = 48000, CH = 2;
let cancelled = false;
self.onmessage = ({ data }) => {
  if (data.type === "cancel") cancelled = true;
  if (data.type === "start") run(data.cfg).catch((e) => self.postMessage({ type: "error", error: String(e?.stack ?? e) }));
};

const VIDEO = {
  h264: { enc: "avc1.640028", mp4: "avc", webm: null },
  vp9: { enc: "vp09.00.40.08", mp4: "vp9", webm: "V_VP9" },
  av1: { enc: "av01.0.08M.08", mp4: "av1", webm: "V_AV1" },
};

// click: 3 ms burst of 2 kHz, Hann-shaped, amplitude 0.8, starting at sample `start`
const CLICK_LEN = Math.round(0.003 * SR);
function fillAudio(buf, startSample, n, fps) {
  buf.fill(0);
  // clicks at every whole second (flash frame index k*fps is at t = k s)
  const first = Math.floor(startSample / SR), last = Math.floor((startSample + n - 1) / SR);
  for (let k = first; k <= last; k++) {
    const cs = k * SR;
    for (let i = Math.max(cs, startSample); i < Math.min(cs + CLICK_LEN, startSample + n); i++) {
      const j = i - cs;
      buf[i - startSample] = 0.8 * Math.sin((2 * Math.PI * 2000 * j) / SR) * Math.sin((Math.PI * j) / CLICK_LEN);
    }
  }
}

async function run(cfg) {
  const { codec, container, seconds, width: W, height: H, fps, vbitrate, abitrate, hw = "no-preference", acodecPref = "auto" } = cfg;
  const vdef = VIDEO[codec];
  const totalFrames = Math.round(seconds * fps);
  const t0 = performance.now();

  // ---- capability probe (also reported) ----
  const vcfg = { codec: vdef.enc, width: W, height: H, framerate: fps, bitrate: vbitrate, hardwareAcceleration: hw, latencyMode: "quality", bitrateMode: "variable" };
  if (codec === "h264") vcfg.avc = { format: "avc" };
  const vsup = await VideoEncoder.isConfigSupported(vcfg);
  if (!vsup.supported) return self.postMessage({ type: "unsupported", what: "video", codec: vdef.enc });
  const aacOk = (await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: CH, bitrate: abitrate })).supported;
  const opusOk = (await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: SR, numberOfChannels: CH, bitrate: abitrate })).supported;
  let acodec = acodecPref === "auto" ? (container === "mp4" && aacOk ? "aac" : "opus") : acodecPref;
  if ((acodec === "aac" && !aacOk) || (acodec === "opus" && !opusOk)) return self.postMessage({ type: "unsupported", what: "audio", codec: acodec, aacOk, opusOk });
  if (container === "webm" && (!vdef.webm || acodec !== "opus")) return self.postMessage({ type: "unsupported", what: "container", codec, acodec });
  const acfg = acodec === "aac" ? { codec: "mp4a.40.2", sampleRate: SR, numberOfChannels: CH, bitrate: abitrate } : { codec: "opus", sampleRate: SR, numberOfChannels: CH, bitrate: abitrate };

  // ---- muxer ----
  let muxer, target;
  if (container === "mp4") {
    target = new Mp4Target();
    muxer = new Mp4Muxer({ target, fastStart: "in-memory", firstTimestampBehavior: "strict",
      video: { codec: vdef.mp4, width: W, height: H, frameRate: fps },
      audio: { codec: acodec, numberOfChannels: CH, sampleRate: SR } });
  } else {
    target = new WebmTarget();
    muxer = new WebmMuxer({ target, firstTimestampBehavior: "strict",
      video: { codec: vdef.webm, width: W, height: H, frameRate: fps },
      audio: { codec: "A_OPUS", numberOfChannels: CH, sampleRate: SR } });
  }

  // ---- encoders ----
  let encError = null, vChunks = 0, aChunks = 0, vBytes = 0, aBytes = 0, firstVMeta = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { vChunks++; vBytes += chunk.byteLength; muxer.addVideoChunk(chunk, meta); },
    error: (e) => (encError = e),
  });
  venc.configure(vcfg);
  const aenc = new AudioEncoder({
    output: (chunk, meta) => { aChunks++; aBytes += chunk.byteLength; muxer.addAudioChunk(chunk, meta); },
    error: (e) => (encError = e),
  });
  aenc.configure(acfg);

  // ---- scene ----
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d");
  g.font = `bold ${Math.round(H / 8)}px monospace`;
  let sceneMs = 0;
  const drawFrame = (i) => {
    const s = performance.now();
    if (i % fps === 0) { g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); }
    else {
      const grad = g.createLinearGradient(0, 0, W, H);
      const h = (i * 2) % 360;
      grad.addColorStop(0, `hsl(${h} 60% 18%)`); grad.addColorStop(1, `hsl(${(h + 90) % 360} 60% 10%)`);
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      g.fillStyle = "#e0602a"; g.fillRect((i * 11) % (W - 200), H * 0.55, 200, 120);
      g.fillStyle = "#cfd8dc"; g.fillText(String(i).padStart(6, "0"), 40, H * 0.2);
    }
    sceneMs += performance.now() - s;
  };
  const waitQueue = () => new Promise((r) => { const f = () => { venc.removeEventListener("dequeue", f); r(); }; venc.addEventListener("dequeue", f); });

  // ---- main loop: one video frame, then the audio that covers up to the end of that frame ----
  const abuf = new Float32Array(SR); // reused scratch (planar: [L..., R...])
  const ASZ = acodec === "aac" ? 1024 : 960;
  let audioSamples = 0;
  const feedAudioUntil = (sampleLimit) => {
    while (audioSamples < sampleLimit) {
      const n = Math.min(ASZ, sampleLimit - audioSamples);
      const planar = new Float32Array(n * CH);
      fillAudio(abuf, audioSamples, n, fps);
      planar.set(abuf.subarray(0, n), 0); planar.set(abuf.subarray(0, n), n);
      const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: n, numberOfChannels: CH, timestamp: Math.round((audioSamples / SR) * 1e6), data: planar });
      aenc.encode(ad); ad.close();
      audioSamples += n;
    }
  };
  let lastProgress = 0;
  const encStart = performance.now();
  for (let i = 0; i < totalFrames; i++) {
    if (cancelled) break;
    if (encError) throw encError;
    drawFrame(i);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    feedAudioUntil(Math.round(((i + 1) * SR) / fps));
    while (venc.encodeQueueSize > 4 && !cancelled) await waitQueue();
    const now = performance.now();
    if (now - lastProgress > 1000 || i === totalFrames - 1) {
      lastProgress = now;
      self.postMessage({ type: "progress", frame: i + 1, total: totalFrames, fraction: (i + 1) / totalFrames, encFps: ((i + 1) / (now - encStart)) * 1000, t: now });
    }
  }
  if (cancelled) {
    const c0 = performance.now();
    venc.close(); aenc.close(); // drops queued work, no flush
    target = null; muxer = null;
    return self.postMessage({ type: "cancelled", cancelCloseMs: performance.now() - c0, framesDone: vChunks, t: performance.now() });
  }
  await venc.flush(); await aenc.flush();
  if (encError) throw encError;
  const encodeMs = performance.now() - encStart;
  const m0 = performance.now();
  muxer.finalize();
  const finalizeMs = performance.now() - m0;
  const bytes = target.buffer;
  venc.close(); aenc.close();
  const name = `${codec}-${container}-${seconds}s.${container}`;
  const up0 = performance.now();
  // upload in slices: one 250 MB fetch body crashed the tab (first full-length run), so the memory cost of a
  // non-streaming target is itself a result. The slices keep the harness alive; a shipped muxer must stream to OPFS/disk.
  let uploadOk = true;
  for (let off = 0; off < bytes.byteLength; off += 8 << 20) {
    const r = await fetch(`/out/${name}`, { method: "POST", headers: { "x-append": off ? "1" : "0" }, body: bytes.slice(off, off + (8 << 20)) });
    uploadOk = uploadOk && r.ok;
  }
  const res = { ok: uploadOk };
  self.postMessage({
    type: "done", cfg, name, aacOk, opusOk, acodec, videoConfig: vcfg, audioConfig: acfg, uploadOk: res.ok,
    frames: totalFrames, videoChunks: vChunks, audioChunks: aChunks, videoBytes: vBytes, audioBytes: aBytes, fileBytes: bytes.byteLength,
    encodeMs, sceneMs, finalizeMs, uploadMs: performance.now() - up0, totalMs: performance.now() - t0,
    encodeSpeedVsRealtime: seconds / (encodeMs / 1000), encFps: totalFrames / (encodeMs / 1000),
    encodeSpeedExSceneVsRealtime: seconds / ((encodeMs - sceneMs) / 1000),
  });
}
