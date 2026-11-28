#!/usr/bin/env node
/* global document, MutationObserver, requestAnimationFrame, KeyboardEvent */
// Edit latency (issue #208, ADR 0020): split / undo / redo on `?sample=2h` (2300 clips), key press to the next painted frame, at 1x and 4x CPU throttle.
//   npm run build && node tests/perf/edit-latency.mjs            (serves apps/web/dist with `vite preview` on :4199)
//   BENCH_URL=http://host:port node tests/perf/edit-latency.mjs   (an already-running site)
//   EDIT_N=15 (splits per run) · EDIT_SAMPLE=2h (the `?sample=` value) · BENCH_OUT=file.json writes the raw numbers
// "commit" = key dispatch until #tl-summary (it carries the clip count) shows the new project: engine apply + patch + store + React commit.
// "key->paint" = key dispatch until the end of the first animation frame after that (so it includes the canvas redraw and has the display's frame wait in it).
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
      const commit = performance.now() - t0; // key -> the new project is in the DOM (engine apply + patch + store + React commit)
      // The frame that shows it: its animation frame, then a task queued from it (runs after that frame's paint).
      requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve({ keyToPaint: performance.now() - t0, commit, changed: true }); ch.port2.postMessage(0); });
    });
    mo.observe(sum, { childList: true, characterData: true, subtree: true });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: key.key, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, bubbles: true, cancelable: true }));
    setTimeout(() => { mo.disconnect(); resolve({ keyToPaint: NaN, changed: false }); }, 3000);
  }), { key });
  // Warm-up at 1x (module load, JIT), then throttle.
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await once({ key: 's' }); await once({ key: 'z', ctrl: true }); }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  const split = [], undo = [], redo = [], commits = [];
  if (process.env.EDIT_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  for (let i = 0; i < N; i++) {
    await page.keyboard.press('ArrowRight');
    const a = await once({ key: 's' }); if (a.changed) { split.push(a.keyToPaint); commits.push(a.commit); }
    const b = await once({ key: 'z', ctrl: true }); if (b.changed) undo.push(b.keyToPaint);
    const c = await once({ key: 'z', ctrl: true, shift: true }); if (c.changed) redo.push(c.keyToPaint);
    await once({ key: 'z', ctrl: true }); // back to the unsplit state for the next iteration
  }
  if (process.env.EDIT_PROFILE) { // EDIT_PROFILE=1: top self-time functions of the main thread over the whole loop
    const { profile } = await cdp.send('Profiler.stop');
    const dt = profile.timeDeltas, self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => { const f = byId.get(id).callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0)); });
    console.log(`--- ${rate}x profile (self ms over ${N * 4} edits)`);
    const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const via = new Map(); // self time of native frames (layout, style, getBoundingClientRect...) by the JS function that called them
    profile.samples.forEach((id, i) => { const n = byId.get(id); if (!/^\(|^[a-z]+[A-Z]?[a-zA-Z]*$/.test(n.callFrame.functionName) || n.callFrame.url) return; let q = parent.get(id); while (q && !byId.get(q).callFrame.url) q = parent.get(q); const f = q && byId.get(q).callFrame; const k = `${n.callFrame.functionName} <- ${f ? `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}` : '?'}`; via.set(k, (via.get(k) ?? 0) + (dt[i] ?? 0)); });
    console.log('native time by caller:'); for (const [k, v] of [...via].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
    for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
  }
  results[`${rate}x`] = { splits: split.length, commit: median(commits), split: median(split), undo: median(undo), redo: median(redo), raw: { split, undo, redo } };
  await ctx.close();
}
await browser.close();
server?.kill();
if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(results));
for (const [k, r] of Object.entries(results)) console.log(`${k.padEnd(3)} median over ${r.splits} splits: split commit ${r.commit.toFixed(1)} ms, key->paint ${r.split.toFixed(1)} ms  undo ${r.undo.toFixed(1)} ms  redo ${r.redo.toFixed(1)} ms`);
const bad = results['1x'].splits < N / 2;
if (bad) { console.error('most splits did not change the project: the playhead is not over a clip'); process.exit(1); }
