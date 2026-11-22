#!/usr/bin/env node
// S8 benchmark: 1000 clips x 20 tracks, scripted pan/zoom, desktop and 4x CPU throttle (ADR 0007, docs/features/timeline-view.md).
//   npm run build && node tests/perf/timeline-bench.mjs            (serves apps/web/dist with `vite preview` on :4198)
//   BENCH_URL=http://host:port node tests/perf/timeline-bench.mjs   (an already-running site)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const url = process.env.BENCH_URL;
let server = null;
let base = url;
if (!base) {
  base = 'http://localhost:4198';
  server = spawn('npx', ['vite', 'preview', '--port', '4198', '--strictPort'], { cwd: 'apps/web', stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }
}
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const results = {};
for (const [label, viewport, rate, dsf] of [['desktop 1280x800', { width: 1280, height: 800 }, 1, 1], ['desktop 1280x800, 4x CPU throttle', { width: 1280, height: 800 }, 4, 1], ['phone 390x844 dpr3, 4x CPU throttle', { width: 390, height: 844 }, 4, 3]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  await page.goto(`${base}/#timeline-bench`);
  await page.waitForFunction(() => typeof globalThis.__timelineBench === 'function');
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  results[label] = await page.evaluate(() => globalThis.__timelineBench(240));
  await ctx.close();
}
await browser.close();
server?.kill();
console.log(JSON.stringify(results, null, 1));
let fail = false;
for (const [label, r] of Object.entries(results)) for (const p of r.phases) {
  const bar = label.includes('throttle') ? 30 : 60;
  console.log(`${label.padEnd(40)} ${p.name.padEnd(9)} ${p.fps.toFixed(1).padStart(6)} fps  p95 ${p.p95Ms.toFixed(1)} ms  JS draw ${p.drawAvgMs.toFixed(2)} ms, +raster ${p.flushAvgMs.toFixed(2)} ms  clips drawn <= ${p.clipsDrawn}`);
  if (p.fps < bar * 0.97) fail = true;
}
process.exit(fail && process.env.BENCH_STRICT ? 1 : 0);
