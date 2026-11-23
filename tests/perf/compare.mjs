#!/usr/bin/env node
// Compare a perf run with a baseline (M1-043). Warn at +10% worse, fail (exit 1) at +25% worse; "worse" follows each metric's direction
// (fps: lower is worse; ms, KB: higher is worse). Not wired into CI (that is a process change): run it by hand or from a CI job later.
//   node tests/perf/compare.mjs [new.json] [baseline.json]       defaults: tests/perf/perf-results.json  tests/perf/baseline.json
//   npm run perf:compare -- new.json baseline.json
// Only compare runs from the same kind of machine; a container baseline against a laptop run is meaningless.
import { readFileSync } from 'node:fs';
import { byKey, fmt } from './metrics.mjs';

export const WARN = 0.10;
export const FAIL = 0.25;
// Absolute floor below which a change is noise (a 0.01 ms metric moving 30% is a timer tick, not a regression).
const NOISE = { ms: 0.05, fps: 0.5, KB: 1, x: 0.05, frames: 2, layers: 0.5 };

/** Returns { rows, worst } where each row is { key, base, now, pct, status } and pct is the signed "worse" fraction (positive = worse). */
export function compare(now, base) {
  const rows = [];
  for (const [key, v] of Object.entries(now.metrics)) {
    const meta = byKey[key];
    const b = base.metrics[key];
    if (!meta || typeof b !== 'number') { rows.push({ key, base: b, now: v, pct: null, status: meta ? 'new' : 'unknown' }); continue; }
    const worse = meta.better === 'lower' ? v - b : b - v;
    const pct = b === 0 ? (worse > 0 ? Infinity : 0) : worse / Math.abs(b);
    const quiet = Math.abs(v - b) < (NOISE[meta.unit] ?? 0);
    const status = quiet ? 'ok' : pct >= FAIL ? 'FAIL' : pct >= WARN ? 'warn' : 'ok';
    rows.push({ key, base: b, now: v, pct, status });
  }
  for (const key of Object.keys(base.metrics)) if (!(key in now.metrics)) rows.push({ key, base: base.metrics[key], now: undefined, pct: null, status: 'missing' });
  return rows;
}

export function render(rows) {
  const lines = [`${'metric'.padEnd(30)} ${'baseline'.padStart(10)} ${'now'.padStart(10)} ${'change'.padStart(9)}  status`];
  for (const r of rows) {
    const ch = r.pct === null ? '' : `${r.pct >= 0 ? '+' : ''}${(r.pct * 100).toFixed(1)}%`;
    lines.push(`${r.key.padEnd(30)} ${fmt(r.base).padStart(10)} ${fmt(r.now).padStart(10)} ${ch.padStart(9)}  ${r.status}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [nowFile = 'tests/perf/perf-results.json', baseFile = 'tests/perf/baseline.json'] = process.argv.slice(2);
  const rows = compare(JSON.parse(readFileSync(nowFile, 'utf8')), JSON.parse(readFileSync(baseFile, 'utf8')));
  console.log(render(rows));
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  const warns = rows.filter((r) => r.status === 'warn').length;
  console.log(`\n${fails} regression(s) >= ${FAIL * 100}% (fail), ${warns} >= ${WARN * 100}% (warn)`);
  process.exit(fails ? 1 : 0);
}
