// S10 resume test: segmented proxy build, kill -9 mid-build, resume, compare with an uninterrupted build.
// Usage: node resume.mjs <src.mp4> <workdir> [segSec=4] [killAfterMs=9000]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, renameSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [src, dir, segArg, killArg] = process.argv.slice(2);
const SEG = Number(segArg ?? 4), KILL = Number(killArg ?? 9000), FPS = 30;
if (process.env.S10_WORKER) { await worker(process.env.S10_WORKER); process.exit(0); }
const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' }).stdout);
const n = Math.ceil(dur / SEG);
// One segment = one closed-GOP file (keyframe at frame 0, GOP 30, no B-frames), written to .tmp and renamed when complete (OPFS: manifest entry written after the file).
async function worker(d) {
  for (let i = 0; i < n; i++) {
    const f = `${d}/seg-${String(i).padStart(3, '0')}.mp4`;
    if (existsSync(f)) continue;                       // finished before the kill
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-ss', String(i * SEG), '-i', src, '-an', '-frames:v', String(SEG * FPS),
      '-vf', 'scale=1280:720:flags=bicubic,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '1', '-crf', '26', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '0', '-f', 'mp4', '-movflags', '+faststart', `${f}.tmp`]);
    if (r.status) throw new Error('ffmpeg failed');
    renameSync(`${f}.tmp`, f);
  }
}
const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');
const done = (d) => readdirSync(d).filter((x) => x.endsWith('.mp4')).sort();
const frames = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout);
const A = `${dir}/full`, B = `${dir}/killed`;
for (const d of [A, B]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
const exec = (d) => new Promise((res) => { const c = spawn(process.execPath, [new URL(import.meta.url).pathname, src, dir, String(SEG)], { env: { ...process.env, S10_WORKER: d }, detached: true, stdio: 'inherit' }); c.on('exit', res); c.pid && (globalThis.__child = c); });
let t = performance.now(); await exec(A); const tFull = performance.now() - t;
// interrupted run: kill -9 the whole process group (worker + its ffmpeg) after KILL ms
t = performance.now();
const p = exec(B); setTimeout(() => { try { process.kill(-globalThis.__child.pid, 'SIGKILL'); } catch {} }, KILL); await p;
const afterKill = done(B), leftovers = readdirSync(B).filter((x) => x.endsWith('.tmp'));
for (const l of leftovers) rmSync(`${B}/${l}`);                                  // resume step 1: drop the partial segment
const tKill = performance.now() - t;
t = performance.now(); await exec(B); const tResume = performance.now() - t;     // resume step 2: build the missing ones
const fa = done(A), fb = done(B);
const identical = fa.length === fb.length && fa.every((f, i) => f === fb[i] && md5(`${A}/${f}`) === md5(`${B}/${f}`));
let total = 0; for (const f of fb) total += frames(`${B}/${f}`);
const res = { segSec: SEG, segments: n, killAfterMs: KILL, segmentsDoneAtKill: afterKill.length, partialDropped: leftovers.length, fullBuildS: tFull / 1000, resumeBuildS: tResume / 1000,
  lostMediaSeconds: SEG, identicalBytes: identical, framesInResumed: total, framesExpected: Math.round(dur * FPS), perSegmentBuildS: tFull / 1000 / n };
writeFileSync(`${dir}/resume.json`, JSON.stringify(res, null, 1)); console.log(res);
