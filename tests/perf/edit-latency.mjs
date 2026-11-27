#!/usr/bin/env node
// Edit latency (issue #208, ADR 0020): split / undo / redo on `?sample=2h` (2300 clips), key press to the next painted frame, at 1x and 4x CPU throttle.
//   npm run build && node tests/perf/edit-latency.mjs            (serves apps/web/dist with `vite preview` on :4199)
//   BENCH_URL=http://host:port node tests/perf/edit-latency.mjs   (an already-running site)
//   EDIT_N=15 (splits per run) · EDIT_SAMPLE=2h (the `?sample=` value) · BENCH_OUT=file.json writes the raw numbers
// "key to paint" = dispatch of the key until two animation frames after the clip count in #tl-summary changed. The summary updates
// with the project, so the number covers engine apply + patch + store + React + canvas redraw, not just the engine call.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const N = Number(process.env.EDIT_N ?? 15);
const sample = process.env.EDIT_SAMPLE ?? '2h';
let base = process.env.BENCH_URL;
let server = null;
if (!base) {
  base = 'http://localhost:4199';
  server = spawn('npx', ['vite', 'preview', '--port', '4199', '--strictPort'], { cwd: 'apps/web', stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const results = {};
for (const rate of [1, 4]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/?sample=${sample}`);
  await page.getByTestId('engine').waitFor({ state: 'attached', timeout: 60_000 });
  await page.waitForFunction(() => /[\d,]+ clips/.test(document.querySelector('#tl-summary')?.textContent ?? ''), null, { timeout: 60_000 });
  const cdp = await ctx.newCDPSession(page);
  await page.getByTestId('timeline-canvas').focus();
  await page.keyboard.press('Home'); // playhead to 0
  // The playhead steps along the first clip; each iteration splits (S), undoes (Ctrl+Z) and redoes (Ctrl+Shift+Z).
  const once = (key) => page.evaluate(({ key }) => new Promise((resolve) => {
    const el = document.querySelector('[data-testid="timeline-canvas"]');
    const sum = document.querySelector('#tl-summary');
    const before = sum.textContent;
    const t0 = performance.now();
    const mo = new MutationObserver(() => {
      if (sum.textContent === before) return;
      mo.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ keyToPaint: performance.now() - t0, changed: true })));
    });
    mo.observe(sum, { childList: true, characterData: true, subtree: true });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: key.key, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, bubbles: true, cancelable: true }));
    setTimeout(() => { mo.disconnect(); resolve({ keyToPaint: NaN, changed: false }); }, 3000);
  }), { key });
  // Warm-up at 1x (module load, JIT), then throttle.
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await once({ key: 's' }); await once({ key: 'z', ctrl: true }); }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  const split = [], undo = [], redo = [];
  for (let i = 0; i < N; i++) {
    await page.keyboard.press('ArrowRight');
    const a = await once({ key: 's' }); if (a.changed) split.push(a.keyToPaint);
    const b = await once({ key: 'z', ctrl: true }); if (b.changed) undo.push(b.keyToPaint);
    const c = await once({ key: 'z', ctrl: true, shift: true }); if (c.changed) redo.push(c.keyToPaint);
    await once({ key: 'z', ctrl: true }); // back to the unsplit state for the next iteration
  }
  // Where the time goes: a CPU profile of a few splits + undos.
  results[`${rate}x`] = { splits: split.length, split: median(split), undo: median(undo), redo: median(redo), raw: { split, undo, redo } };
  await ctx.close();
}
await browser.close();
server?.kill();
if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(results));
for (const [k, r] of Object.entries(results)) console.log(`${k.padEnd(3)} key->paint median over ${r.splits} splits: split ${r.split.toFixed(1)} ms  undo ${r.undo.toFixed(1)} ms  redo ${r.redo.toFixed(1)} ms`);
const bad = results['1x'].splits < N / 2;
if (bad) { console.error('most splits did not change the project: the playhead is not over a clip'); process.exit(1); }
