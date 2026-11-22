import type { Capabilities } from "@app/engine-client";
import type { TestResult, Verdict } from "./types";

const num = (r: TestResult, k: string): number | null => { const v = r.metrics[k]; return typeof v === "number" ? v : null; };
const grade = (v: number | null, good: number, ok: number, higherIsBetter: boolean): Verdict =>
  v === null || Number.isNaN(v) ? "na" : higherIsBetter ? (v >= good ? "good" : v >= ok ? "ok" : "slow") : v <= good ? "good" : v <= ok ? "ok" : "slow";

/** A rough guide for non-engineers; the real numbers are always shown next to it. */
export function verdict(r: TestResult): Verdict {
  if (r.status !== "ok") return "na";
  switch (r.id) {
    case "decode": return grade(num(r, "fps"), 90, 45, true);
    case "seek": return grade(num(r, "gop150_p95_ms"), 150, 400, false);
    case "gpuUpload": return grade(num(r, "direct_p50_ms") ?? num(r, "copy_p50_ms") ?? num(r, "cpu_p50_ms"), 6, 20, false);
    case "fillRate": return grade(num(r, "layers_at_60fps"), 8, 4, true);
  }
}

type T = (key: string, values?: Record<string, string | number>) => string;

/** One plain sentence of what the numbers mean. `t` is the app translator. */
export function sentence(r: TestResult, t: T): string {
  if (r.status === "unsupported") return t("diag.s.unsupported", { reason: r.reason ?? "" }).trim();
  if (r.status === "timeout") return t("diag.s.timeout");
  if (r.status === "error") return t("diag.s.error", { reason: r.reason ?? t("diag.s.errorUnknown") });
  const m = r.metrics;
  const n = (k: string) => (typeof m[k] === "number" ? Number(m[k]) : 0);
  switch (r.id) {
    case "decode": return t("diag.s.decode", { fps: n("fps") });
    case "seek": return t("diag.s.seek", { a: n("gop30_p50_ms"), b: n("gop150_p50_ms"), c: n("gop150_p95_ms") });
    case "gpuUpload": {
      const f = (k: string) => (typeof m[`${k}_p50_ms`] === "number" ? t("diag.s.ms", { n: n(`${k}_p50_ms`) }) : t("diag.s.failed"));
      return t("diag.s.gpuUpload", { direct: f("direct"), copy: f("copy"), cpu: f("cpu") });
    }
    case "fillRate": return t("diag.s.fillRate", { ms: n("frame_p50_ms"), layers: n("layers"), at60: n("layers_at_60fps") });
  }
}

const sup = (s: string) => ({ hardware: "hw", supported: "sw", no: "no", unknown: "?" })[s] ?? "?";

/** The compact block people paste back: one JSON line, short keys, nothing personal beyond the browser's own user-agent string. */
export function buildReport(caps: Capabilities | null, results: readonly TestResult[], app: { version: string; backend: string }, now = new Date()): string {
  const gpu = caps?.webgpu.adapter;
  const data = {
    overcut_device_report: 1,
    at: now.toISOString(),
    app: `${app.version} ${app.backend}`,
    ua: caps?.platform.user_agent ?? navigator.userAgent,
    device: caps && {
      platform: caps.platform.platform, os: caps.platform.os, arch: caps.platform.arch,
      cores: caps.platform.hardware_concurrency, mem_gb: caps.platform.device_memory_gb,
      gpu: gpu ? [gpu.vendor, gpu.architecture, gpu.description].filter(Boolean).join(" / ") + (gpu.fallback ? " (software)" : "") : null,
      gl2: caps.webgl2.renderer,
      limits: caps.webgpu.limits,
      webgpu: caps.webgpu.available, webgl2: caps.webgl2.available,
      sab: caps.shared_array_buffer, isolated: caps.cross_origin_isolated, opfs: caps.opfs,
      codecs: Object.fromEntries(caps.codecs.map((c) => [c.codec, `dec:${sup(c.decode)} enc:${sup(c.encode)}`])),
      issues: caps.issues,
    },
    tests: Object.fromEntries(results.map((r) => [r.id, { status: r.status, ...(r.reason ? { why: r.reason } : {}), took_ms: r.took_ms, ...r.metrics, verdict: verdict(r) }])),
  };
  return JSON.stringify(data);
}

