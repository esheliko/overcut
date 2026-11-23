#!/usr/bin/env node
/* global window, document -- used inside page.evaluate callbacks, which run in the browser */
// One performance run (M1-043): `npm run perf` builds once, then measures everything headless and writes tests/perf/perf-results.json.
//   npm run perf                  build + all scenarios
//   npm run perf -- --no-build    reuse apps/web/dist and the Rust target (faster re-runs)
//   npm run perf -- --out file    write the result elsewhere (default tests/perf/perf-results.json, git-ignored)
// Numbers from a container are TREND numbers (software decode, shared CPU): compare against a baseline from the same kind of machine
// (tests/perf/compare.mjs), never against device budgets. Device numbers come from /diagnostics (`npm run perf:device`).
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, totalmem, platform, arch, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const outFile = resolve(opt('--out', 'tests/perf/perf-results.json'));
const PORT = 4199;
const base = `http://localhost:${PORT}`;
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...o });
const log = (s) => console.error(`perf: ${s}`);
const metrics = {};
const notes = {};
const set = (k, v) => { if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = Number(v.toPrecision(5)); };
const skipped = (what, e) => { notes[what] = `skipped: ${e instanceof Error ? e.message : e}`; log(`${what} skipped: ${notes[what]}`); };

// 1. Build once.
if (!flag('--no-build')) { log('building (npm run build)'); sh('npm', ['run', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] }); }

// 2. Rust micro-benchmarks (ops apply, evaluate).
try {
  log('rust micro-benches');
  const r = JSON.parse(sh('cargo', ['run', '-q', '--release', '-p', 'app-timeline', '--example', 'bench']).trim().split('\n').pop());
  set('ops.apply_ms', r.ops_apply_ms); set('ops.evaluate_ms', r.evaluate_ms);
  notes.rust = `${r.clips} clips on ${r.tracks} tracks`;
} catch (e) { skipped('rust', e); }

// 3. Bundle sizes (gzip of what the build emitted).
try {
  const dir = 'apps/web/dist/assets';
  const gz = (f) => gzipSync(readFileSync(join(dir, f))).length / 1024;
  const files = readdirSync(dir);
  const sum = (re) => files.filter((f) => re.test(f)).reduce((a, f) => a + gz(f), 0);
  set('size.shell_js_gzip_kb', sum(/^index-.*\.(js|css)$/));
  set('size.engine_js_gzip_kb', sum(/^(app_wasm|wasm)-.*\.js$/));
  set('size.engine_wasm_gzip_kb', Math.max(0, ...files.filter((f) => f.endsWith('.wasm')).map(gz)));
} catch (e) { skipped('sizes', e); }

// 4. Serve the build and drive it.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: 'apps/web', stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 75; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const env = { browser: browser.version() };
try {
  // 4a. Cold and warm start to engine ready: a fresh context has no cache and no service worker; the second load in it is the cached one.
  try {
    log('startup');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const load = async () => { const t0 = performance.now(); await page.goto(base + '/'); await page.waitForFunction(() => /\(wasm\)/.test(document.querySelector('[data-testid="engine"]')?.textContent ?? ''), null, { timeout: 60_000 }); return performance.now() - t0; };
    set('startup.cold_ms', await load());
    await page.evaluate(() => navigator.serviceWorker?.ready).catch(() => {});
    set('startup.warm_ms', await load());
    await ctx.close();
  } catch (e) { skipped('startup', e); }

  // 4b. Timeline pan/zoom and drag input-to-paint (tests/perf/timeline-bench.mjs, S8): desktop, 4x throttle, phone dpr3.
  try {
    log('timeline bench (about 1 min)');
    const f = join(mkdtempSync(join(tmpdir(), 'perf-')), 'timeline.json');
    execFileSync('node', ['tests/perf/timeline-bench.mjs'], { env: { ...process.env, BENCH_URL: base, BENCH_OUT: f }, stdio: ['ignore', 'ignore', 'inherit'] });
    const r = JSON.parse(readFileSync(f, 'utf8'));
    for (const [label, v] of Object.entries(r)) {
      const id = label.startsWith('phone') ? 'phone_4x' : label.includes('throttle') ? 'desktop_4x' : 'desktop';
      set(`timeline.${id}.min_fps`, Math.min(...v.phases.map((p) => p.fps)));
      set(`drag.${id}.p95_ms`, Math.max(v.drag.single.p95Ms, v.drag.all.p95Ms));
    }
  } catch (e) { skipped('timeline', e); }

  // 4c. Preview playback (2 s), dropped frames and scrub latency, on the 320x180 fixture (the same method as tests/smoke/preview.spec.ts).
  try {
    log('preview and scrub');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.waitForFunction(() => /\(wasm\)/.test(document.querySelector('[data-testid="engine"]')?.textContent ?? ''), null, { timeout: 60_000 });
    await page.getByTestId('preview-import').waitFor({ state: 'visible' });
    await page.getByTestId('preview-input').setInputFiles('crates/media/tests/fixtures/flash_click.mp4');
    await page.waitForSelector('.canvas[data-loaded="true"]', { timeout: 30_000 });
    await page.waitForFunction(async () => ((await window.__overcutPreview?.media())?.length ?? 0) > 0, null, { timeout: 30_000 });
    await page.keyboard.press('Space');
    await page.waitForTimeout(2000);
    await page.keyboard.press('Space');
    const r = await page.evaluate(async () => {
      const s = await window.__overcutPreview.stats();
      const t = s.times; const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
      const late = [...s.late].sort((a, b) => a - b);
      return { fps: span ? (t.length - 1) / span : 0, dropped: s.dropped, p95Late: late[Math.floor(late.length * 0.95)] ?? 0 };
    });
    set('preview.fps', r.fps); set('preview.dropped', r.dropped); set('preview.p95_late_ms', r.p95Late);
    await page.keyboard.press('Home');
    const sc = await page.evaluate(async () => {
      const h = window.__overcutPreview; const n0 = (await h.stats()).scrubMs.length;
      for (let i = 0; i < 40; i++) { h.player.seek((i * 37) % 85); await new Promise((res) => setTimeout(res, 40)); }
      await new Promise((res) => setTimeout(res, 300));
      const a = (await h.stats()).scrubMs.slice(n0).sort((x, y) => x - y);
      return { p50: a[a.length >> 1] ?? 0, p95: a[Math.floor(a.length * 0.95)] ?? 0, n: a.length };
    });
    if (sc.n > 10) { set('scrub.p50_ms', sc.p50); set('scrub.p95_ms', sc.p95); }
    await ctx.close();
  } catch (e) { skipped('preview', e); }

  // 4d. Export speed against real time: 1080p30, 5 s synthetic project; H.264 first, VP9/WebM when this browser has no H.264 encoder.
  try {
    log('export');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(base + '/#export-harness');
    await page.waitForFunction(() => window.__exportHarness !== undefined, null, { timeout: 60_000 });
    const run = (settings) => page.evaluate((s) => window.__exportHarness.run({ seconds: 5, width: 1920, height: 1080, settings: s }), settings);
    let r = await run({ container: 'mp4', videoCodec: 'h264' });
    if (!r.ok) r = await run({ container: 'webm', videoCodec: 'vp9' });
    if (r.ok) { set('export.speed_x', r.stats.speedVsRealtime); env.exportCodecs = r.stats.codecs; } else skipped('export', `${r.code}: ${r.message}`);
    await ctx.close();
  } catch (e) { skipped('export', e); }
} finally {
  await browser.close();
  server.kill();
}

const sha = (() => { try { return sh('git', ['rev-parse', '--short', 'HEAD']).trim(); } catch { return null; } })();
const result = {
  overcut_perf: 1,
  at: new Date().toISOString(),
  commit: sha,
  environment: { kind: 'container-or-ci (trend numbers, not device numbers)', node: process.version, os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30), ...env },
  notes,
  metrics,
};
writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
console.log(`perf: wrote ${outFile} (${Object.keys(metrics).length} metrics)`);
