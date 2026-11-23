#!/usr/bin/env node
// Import one /diagnostics device report (M1-043): stores tests/perf/devices/<device>.json and prints it against the budgets.
//   npm run perf:device -- --tier mid --name iphone-14 '<pasted JSON line>'
//   npm run perf:device -- --tier laptop report.txt          (a file works too; or pipe it on stdin with "-")
// --tier low|mid|laptop|desktop  which budget column to judge against (default: guessed: phone user agent = mid, else laptop).
//   low is never a real device here (ADR 0013): pass --proxy-ratio <n> with a Galaxy S24 report and the numbers are scaled to a
//   "calibrated proxy" (times x n, rates / n), marked as such in the file.
// --name <slug>  file name (default: guessed from the user agent).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { byKey, fmt, judge, TIERS } from './metrics.mjs';

/** Map a report (`overcut_device_report: 1`, apps/web/src/diagnostics/report.ts) to catalog metrics. */
export function metricsOf(report) {
  const t = report.tests ?? {};
  const out = {};
  const n = (x) => (typeof x === 'number' ? x : undefined);
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  put('device.decode_fps', n(t.decode?.fps));
  put('device.seek_gop30_p50_ms', n(t.seek?.gop30_p50_ms));
  put('device.seek_gop150_p95_ms', n(t.seek?.gop150_p95_ms));
  put('device.fill_layers_at_60fps', n(t.fillRate?.layers_at_60fps));
  put('device.upload_p50_ms', n(t.gpuUpload?.direct_p50_ms) ?? n(t.gpuUpload?.copy_p50_ms) ?? n(t.gpuUpload?.cpu_p50_ms));
  return out;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
function guessName(r) {
  const ua = r.ua ?? '';
  const m = /\((?:Linux; Android [\d.]+; ([^;)]+)|(iPhone)|(Macintosh)|(Windows NT [\d.]+))/.exec(ua);
  return slug(m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : (r.device?.platform ?? 'device'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const take = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; return args.splice(i, 2)[1]; };
  const tierArg = take('--tier'); const nameArg = take('--name'); const ratio = take('--proxy-ratio');
  const src = args.join(' ').trim();
  let text = src === '-' ? readFileSync(0, 'utf8') : existsSync(src) ? readFileSync(src, 'utf8') : src;
  const at = text.indexOf('{"overcut_device_report"');
  if (at < 0) { console.error('perf:device: no "overcut_device_report" JSON found in the input (copy the report from /diagnostics, whole line)'); process.exit(2); }
  let report;
  try { report = JSON.parse(text.slice(at, text.lastIndexOf('}') + 1)); } catch (e) { console.error(`perf:device: the JSON is cut or damaged (${e.message}); copy the whole line`); process.exit(2); }
  const tier = tierArg ?? (/Mobile|iPhone|Android/.test(report.ua ?? '') ? 'mid' : 'laptop');
  if (!TIERS.includes(tier)) { console.error(`perf:device: --tier must be one of ${TIERS.join(', ')}`); process.exit(2); }
  const name = nameArg ? slug(nameArg) : guessName(report);
  let metrics = metricsOf(report);
  const proxy = ratio ? Number(ratio) : null;
  if (proxy) for (const [k, v] of Object.entries(metrics)) metrics[k] = Number((byKey[k].better === 'lower' ? v * proxy : v / proxy).toPrecision(5));
  mkdirSync('tests/perf/devices', { recursive: true });
  const file = `tests/perf/devices/${name}.json`;
  writeFileSync(file, JSON.stringify({ overcut_perf_device: 1, name, tier, label: proxy ? 'calibrated proxy' : 'measured on device', proxyRatio: proxy, at: report.at, app: report.app, device: report.device, metrics, report }, null, 2) + '\n');
  console.log(`${name} (${tier}${proxy ? `, calibrated proxy x${proxy}` : ''}) -> ${file}\n`);
  console.log(`${'metric'.padEnd(36)} ${'value'.padStart(9)} ${'budget'.padStart(9)}  result`);
  for (const [k, v] of Object.entries(metrics)) {
    const meta = byKey[k]; const bud = meta.budgets[tier]; const j = judge(meta, v, tier);
    console.log(`${meta.label.slice(0, 36).padEnd(36)} ${fmt(v).padStart(9)} ${(bud === null ? '-' : (meta.better === 'lower' ? '<= ' : '>= ') + bud).padStart(9)}  ${j === 'none' ? 'no budget' : j.toUpperCase()}`);
  }
  const miss = Object.keys(byKey).filter((k) => k.startsWith('device.') && !(k in metrics));
  if (miss.length) console.log(`\nnot in the report (test failed, unsupported or skipped): ${miss.join(', ')}`);
}
