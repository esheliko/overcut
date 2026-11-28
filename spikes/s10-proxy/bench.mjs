// S10 (M2-020) proxy benchmark. Throw-away spike: ffmpeg CLI stand-in for the encoders (libx264 here;
// the product uses WebCodecs/hardware, see ADR 0016). Usage: node bench.mjs <src4k.mp4> <workdir> [seeks=30]
import { spawnSync } from 'node:child_process';
import { statSync, mkdirSync, writeFileSync } from 'node:fs';
const [src, dir, seeksArg] = process.argv.slice(2);
const seeks = Number(seeksArg ?? 30);
mkdirSync(dir, { recursive: true });
const run = (args) => { const t = performance.now(); const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return performance.now() - t; };
const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' }).stdout);
const size = (f) => statSync(f).size;
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const times = Array.from({ length: seeks }, () => 0.5 + rnd() * (dur - 1.5));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
// seek = open + accurate seek (decode from the keyframe to the target) + 1 frame, single decode thread; minus the cost of opening and decoding frame 0
const seekMs = (f) => {
  const base = []; for (let i = 0; i < 5; i++) base.push(run(['-threads', '1', '-i', f, '-an', '-frames:v', '1', '-f', 'null', '-']));
  const b = pct(base, 0.5);
  const s = times.map((t) => run(['-threads', '1', '-ss', t.toFixed(3), '-i', f, '-an', '-frames:v', '1', '-f', 'null', '-']) - b);
  return { p50: pct(s, 0.5), p95: pct(s, 0.95), base: b };
};
const out = [];
const srcSeek = seekMs(src);
out.push({ name: 'source 4K (GOP 150, 2 B)', mb: size(src) / 1e6, ratio: 1, ...srcSeek });
const V = [
  ['540p g30', 960, 540, 30, 26], ['540p g8', 960, 540, 8, 26], ['540p intra', 960, 540, 1, 26],
  ['720p g30', 1280, 720, 30, 26], ['720p g15', 1280, 720, 15, 26], ['720p intra', 1280, 720, 1, 26],
];
for (const [name, w, h, g, crf] of V) {
  const f = `${dir}/p-${name.replace(' ', '-')}.mp4`;
  const enc = ['-an', '-vf', `scale=${w}:${h}:flags=bicubic,format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-g', String(g), '-keyint_min', String(g), '-sc_threshold', '0', '-bf', '0', '-movflags', '+faststart', f];
  const tAll = run(['-i', src, ...enc]);               // all cores
  const t1 = run(['-threads', '1', '-i', src, ...enc.slice(0, -1).concat(['-threads', '1', f])]); // one core
  const sk = seekMs(f);
  out.push({ name, mb: size(f) / 1e6, ratio: size(f) / size(src), xrt4: dur / (tAll / 1000), xrt1: dur / (t1 / 1000), ...sk });
}
writeFileSync(`${dir}/bench.json`, JSON.stringify({ dur, seeks, out }, null, 1));
console.log(`source ${dur.toFixed(1)} s, ${seeks} seeded random seeks`);
for (const o of out) console.log(`${o.name.padEnd(26)} ${o.mb.toFixed(1).padStart(7)} MB  ${(o.ratio * 100).toFixed(1).padStart(5)}%  ${o.xrt4 ? `enc ${o.xrt4.toFixed(2)}x(4c) ${o.xrt1.toFixed(2)}x(1c)` : ''}  seek p50 ${o.p50.toFixed(0)} p95 ${o.p95.toFixed(0)} ms (open ${o.base.toFixed(0)})`);
