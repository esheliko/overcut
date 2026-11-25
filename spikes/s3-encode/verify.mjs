// A/V sync verification of an encoded file, independent of the encoder: decode it with ffmpeg the way a player would
// (edit lists applied), find white-flash frames (video pts) and click onsets (audio samples), report the offset per second.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out = []; p.stdout.on("data", (c) => out.push(c)); let err = ""; p.stderr.on("data", (c) => (err += c));
  p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} ${code}: ${err.slice(-500)}`))));
});

/** `period`: timeline seconds between flashes/clicks (1 for a normal clip, 1 / speed for a sped-up one). */
export async function verify(file, seconds, fps = 30, period = 1) {
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_streams", "-show_format", "-of", "json", file]).toString());
  const v = probe.streams.find((s) => s.codec_type === "video"), a = probe.streams.find((s) => s.codec_type === "audio");
  const head = readFileSync(file).subarray(0, 2_000_000);
  const hasElst = head.includes(Buffer.from("elst"));
  // video: per-frame presentation time + mean luma of an 8x8 downscale
  const pts = (await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file])).toString().trim().split("\n").map(Number);
  const raw = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-vf", "scale=8:8:flags=area,format=gray", "-f", "rawvideo", "-"]);
  const nv = raw.length / 64;
  const flashes = [];
  for (let i = 0; i < nv; i++) { let s = 0; for (let j = 0; j < 64; j++) s += raw[i * 64 + j]; if (s / 64 > 235) flashes.push(pts[i]); }
  // audio: decoded mono f32 at 48k; timeline origin = stream start_time (what a player seeks to)
  const aStart = Number(a.start_time ?? 0);
  const pcm = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"]);
  const f = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
  const SR = 48000, offs = [];
  const nClicks = Math.floor(seconds / period + 1e-9);
  for (let k = 0; k < nClicks; k++) {
    // search a window around the nominal click for the first sample above threshold (energy-based, tolerant to codec pre-echo)
    const at = k * period;
    const lo = Math.max(0, Math.round((at - 0.08 - aStart) * SR)), hi = Math.min(f.length, Math.round((at + 0.08 - aStart) * SR));
    let on = -1; for (let i = lo; i < hi; i++) if (Math.abs(f[i]) > 0.25) { on = i; break; }
    if (on < 0) { offs.push(null); continue; }
    const tClick = aStart + on / SR;
    const flash = flashes.reduce((b, t) => (Math.abs(t - at) < Math.abs(b - at) ? t : b), Infinity);
    offs.push((tClick - flash) * 1000);
  }
  const ok = offs.filter((x) => x !== null);
  const mean = (x) => x.reduce((s, y) => s + y, 0) / x.length;
  const third = Math.floor(ok.length / 3);
  const slope = ok.length > 2 ? (mean(ok.slice(-third)) - mean(ok.slice(0, third))) / ((ok.length - third) / 60) : 0; // ms per minute
  const frameMs = 1000 / fps;
  return {
    container: probe.format.format_name, videoCodec: v.codec_name, audioCodec: a.codec_name,
    videoStart: Number(v.start_time), audioStart: aStart, videoDuration: Number(v.duration), audioDuration: Number(a.duration),
    decodedVideoFrames: nv, expectedVideoFrames: Math.round(seconds * fps), videoPackets: Number(v.nb_read_packets), audioPackets: Number(a.nb_read_packets),
    editListPresentInHead: hasElst, flashesFound: flashes.length, expectedFlashes: nClicks, clicksMeasured: ok.length,
    offsetMs: { mean: mean(ok), min: Math.min(...ok), max: Math.max(...ok), maxAbs: Math.max(...ok.map(Math.abs)) },
    maxAbsOffsetFrames: Math.max(...ok.map(Math.abs)) / frameMs, driftMsPerMinute: slope,
    passUnderOneFrame: Math.max(...ok.map(Math.abs)) < frameMs && ok.length === nClicks,
    firstOffsetsMs: offs.slice(0, 5).map((x) => x && +x.toFixed(2)), lastOffsetsMs: offs.slice(-5).map((x) => x && +x.toFixed(2)),
  };
}
if (process.argv[1] && process.argv[1].endsWith("verify.mjs")) console.log(JSON.stringify(await verify(process.argv[2], +process.argv[3] ?? 300, 30, +(process.argv[4] ?? 1)), null, 2));
