// Generates the S1 test clips: 1920x1080, 30 fps, 150 frames, H.264 High, B-frames.
// Frame number n is burned into the pixels as 16 blocks (64x64 px, MSB first, white=1)
// along the top-left, so identity survives lossy coding and colour conversion.
// Needs ffmpeg + ffprobe (dev tool only; the output is committed, the app never uses ffmpeg).
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1920, H = 1080, FPS = 30, FRAMES = 150;
const dir = dirname(fileURLToPath(import.meta.url));

function frame(n) {
  const y = Buffer.alloc(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      // moving texture so P/B frames carry real residual (not a free flat clip)
      y[j * W + i] = 60 + (((i * 3 + j * 2 + n * 7) & 127) >> 1);
    }
  }
  for (let b = 0; b < 16; b++) {
    const v = (n >> (15 - b)) & 1 ? 235 : 16;
    for (let j = 0; j < 64; j++) y.fill(v, j * W + b * 64, j * W + b * 64 + 64);
  }
  const uv = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  return Buffer.concat([y, uv]);
}

async function make(name, gop) {
  const out = join(dir, `${name}.mp4`);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p",
    "-s", `${W}x${H}`, "-r", `${FPS}`, "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "32",
    "-profile:v", "high", "-level", "4.0", "-g", `${gop}`, "-keyint_min", `${gop}`, "-sc_threshold", "0",
    "-bf", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  for (let n = 0; n < FRAMES; n++) {
    if (!ff.stdin.write(frame(n))) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r, e) => ff.on("close", (c) => (c ? e(new Error("ffmpeg " + c)) : r())));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pos,size,pts_time,dts_time,flags", "-of", "json", out], { maxBuffer: 1 << 26 }).toString());
  const pk = probe.packets.map((p) => ({ pos: +p.pos, size: +p.size, pts: Math.round(+p.pts_time * 1e6), dts: Math.round(+p.dts_time * 1e6), key: p.flags.includes("K") }));
  const t0 = Math.min(...pk.map((p) => p.pts));
  for (const p of pk) p.n = Math.round(((p.pts - t0) / 1e6) * FPS);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ width: W, height: H, fps: FPS, frames: FRAMES, packets: pk }));
  console.log(name, `${(statSync(out).size / 1024).toFixed(0)} KiB`, "keyframes", pk.filter((p) => p.key).length);
}

await make("clip-gop30", 30);
await make("clip-gop150", 150);
