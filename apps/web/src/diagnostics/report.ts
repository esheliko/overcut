import type { Capabilities } from "@app/engine-client";
import type { TestId, TestResult, Verdict } from "./types";

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

/** One plain sentence of what the numbers mean. */
export function sentence(r: TestResult): string {
  if (r.status === "unsupported") return `Not supported on this device. ${r.reason ?? ""}`.trim();
  if (r.status === "timeout") return "This test took too long and was stopped. That is itself a sign of a slow device.";
  if (r.status === "error") return `This test could not finish (${r.reason ?? "unknown error"}).`;
  const m = r.metrics;
  switch (r.id) {
    case "decode": return `${m.fps} full-HD frames per second (a smooth video needs 30 to 60).`;
    case "seek": return `Typical jump: ${m.gop30_p50_ms} ms on an editor-friendly video, ${m.gop150_p50_ms} ms on a phone-style video (worst 1 in 20: ${m.gop150_p95_ms} ms).`;
    case "gpuUpload": {
      const f = (k: string) => (typeof m[`${k}_p50_ms`] === "number" ? `${m[`${k}_p50_ms`]} ms` : "failed");
      return `Per frame: direct ${f("direct")}, copy ${f("copy")}, through the processor ${f("cpu")}.`;
    }
    case "fillRate": return `${m.frame_p50_ms} ms to draw ${m.layers} full-HD layers: room for about ${m.layers_at_60fps} layers at 60 frames per second.`;
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

export const TEST_ORDER: TestId[] = ["decode", "seek", "gpuUpload", "fillRate"];
