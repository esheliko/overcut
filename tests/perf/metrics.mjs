// The metric catalog: one place that says what each number is, which direction is better, and its budget per device tier.
// Budgets mirror docs/PERFORMANCE.md (change both together). Tiers: low (calibrated proxy), mid (iPhone 14 class), laptop, desktop.
// `scope`: where the run.mjs number comes from ("container" = headless Chromium on the CI/container CPU, a TREND number, not a device number;
// "device" = produced by /diagnostics on a real device, imported with `npm run perf:device`).
export const TIERS = ['low', 'mid', 'laptop', 'desktop'];

const m = (key, label, unit, better, scope, budgets, note = '') => ({ key, label, unit, better, scope, budgets, note });
const b = (low, mid, laptop, desktop) => ({ low, mid, laptop, desktop });

export const METRICS = [
  m('startup.cold_ms', 'Cold load to engine ready (no cache)', 'ms', 'lower', 'container', b(null, null, null, null), 'budget is for the cached load; cold is a trend number'),
  m('startup.warm_ms', 'Cached load to engine ready', 'ms', 'lower', 'container', b(2500, 1500, 1000, 1000)),
  m('size.shell_js_gzip_kb', 'Shell JS + CSS (gzip)', 'KB', 'lower', 'container', b(250, 250, 250, 250)),
  m('size.engine_js_gzip_kb', 'Engine glue JS (gzip)', 'KB', 'lower', 'container', b(null, null, null, null)),
  m('size.engine_wasm_gzip_kb', 'Engine WASM, largest file (gzip)', 'KB', 'lower', 'container', b(2560, null, null, null)),
  m('timeline.desktop.min_fps', 'Timeline pan/zoom, 1000 clips x 20 tracks, desktop (worst phase)', 'fps', 'higher', 'container', b(30, 60, 60, 60)),
  m('timeline.desktop_4x.min_fps', 'Timeline pan/zoom, desktop, 4x CPU throttle (worst phase)', 'fps', 'higher', 'container', b(30, 30, 30, 30), 'throttle bar 30 fps, tests/perf/timeline-bench.mjs'),
  m('timeline.phone_4x.min_fps', 'Timeline pan/zoom, phone 390x844 dpr3, 4x throttle (worst phase)', 'fps', 'higher', 'container', b(30, 30, 30, 30)),
  m('drag.desktop.p95_ms', 'Drag input-to-paint p95, desktop', 'ms', 'lower', 'container', b(33, 20, 16, 16)),
  m('drag.desktop_4x.p95_ms', 'Drag input-to-paint p95, desktop 4x throttle', 'ms', 'lower', 'container', b(33, 20, 16, 16)),
  m('drag.phone_4x.p95_ms', 'Drag input-to-paint p95, phone dpr3 4x throttle', 'ms', 'lower', 'container', b(33, 20, 16, 16)),
  m('preview.fps', 'Preview playback, presented frames per second (320x180 fixture, software decode)', 'fps', 'higher', 'container', b(30, 30, 60, 60), 'container uses software decode and a tiny clip: trend only'),
  m('preview.dropped', 'Preview dropped frames in 2 s of playback', 'frames', 'lower', 'container', b(null, null, null, null)),
  m('preview.p95_late_ms', 'Preview frame lateness p95', 'ms', 'lower', 'container', b(null, null, null, null)),
  m('scrub.p50_ms', 'Scrub, first frame after seek p50', 'ms', 'lower', 'container', b(120, 80, 50, 33)),
  m('scrub.p95_ms', 'Scrub, first frame after seek p95', 'ms', 'lower', 'container', b(null, null, null, null)),
  m('export.speed_x', 'Export 1080p30, real-time multiple', 'x', 'higher', 'container', b(0.7, 1.5, 3, 5), 'container codec and CPU differ from devices; see export.codecs in the environment'),
  m('ops.apply_ms', 'Apply one op on a 5000-clip project (Rust)', 'ms', 'lower', 'container', b(8, 4, 2, 1)),
  m('ops.evaluate_ms', 'Evaluate one frame on a 5000-clip project (Rust)', 'ms', 'lower', 'container', b(null, null, null, null)),
  // From /diagnostics on a real device (docs/features/diagnostics.md). Budgets are derived from the PERFORMANCE.md rows named in the note.
  m('device.decode_fps', '1080p H.264 sequential decode', 'fps', 'higher', 'device', b(30, 60, 60, 60), 'derived from the preview fps budget: decode must keep up with it'),
  m('device.seek_gop30_p50_ms', 'Random seek p50, GOP 30', 'ms', 'lower', 'device', b(120, 80, 50, 33), 'scrub budget'),
  m('device.seek_gop150_p95_ms', 'Random seek p95, GOP 150', 'ms', 'lower', 'device', b(null, null, null, null), 'no budget yet (long-GOP worst case); reported'),
  m('device.fill_layers_at_60fps', 'Full-HD blended layers at 60 fps', 'layers', 'higher', 'device', b(3, 3, 3, 3), 'preview budget: 3 video layers'),
  m('device.upload_p50_ms', 'VideoFrame to GPU texture p50 (best path)', 'ms', 'lower', 'device', b(null, null, null, null), 'reported'),
];

export const byKey = Object.fromEntries(METRICS.map((x) => [x.key, x]));

/** 'pass' | 'fail' | 'none' against a budget. */
export function judge(metric, value, tier) {
  const bud = metric.budgets[tier];
  if (bud === null || bud === undefined || typeof value !== 'number') return 'none';
  return metric.better === 'lower' ? (value <= bud ? 'pass' : 'fail') : (value >= bud ? 'pass' : 'fail');
}

export const fmt = (v) => (typeof v !== 'number' ? '-' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
