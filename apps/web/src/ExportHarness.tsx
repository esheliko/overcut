/** Export harness: open `/#export-harness`. Drives `engine.export` end to end on a synthetic project (the `test:pattern` media: a flash frame and a click
 *  on every second) and exposes `window.__exportHarness` for the smoke test and for manual measurement. Not linked from the UI; the export dialog is M1-035. */
import { useEffect, useState } from "react";
import { ExportError, createEngine, type Engine, type ExportSettings, type ExportStats, type Project } from "@app/engine-client";

const TICKS = 705_600_000;
const hex = (n: number) => n.toString(16).padStart(32, "0");

export function patternProject(seconds: number, opts: { fps?: [number, number]; width?: number; height?: number } = {}): Project {
  const [num, den] = opts.fps ?? [30, 1];
  return {
    id: hex(1),
    name: "export harness",
    schema_version: 3,
    media: [{ id: hex(2), kind: "video", name: "test pattern", uri: `test:pattern?w=${opts.width ?? 1280}&h=${opts.height ?? 720}` }],
    sequences: [
      {
        id: hex(3),
        name: "main",
        frame_rate: { num, den },
        resolution: { width: opts.width ?? 1280, height: opts.height ?? 720 },
        sample_rate: 48000,
        tracks: [
          { id: hex(4), kind: "video", locked: false, muted: false, name: "V1", clips: [{ id: hex(5), media: hex(2), start: 0, source_in: 0, duration: seconds * TICKS }] },
          { id: hex(6), kind: "audio", locked: false, muted: false, name: "A1", clips: [{ id: hex(7), media: hex(2), start: 0, source_in: 0, duration: seconds * TICKS }] },
        ],
      },
    ],
  };
}

export interface HarnessRun {
  seconds: number;
  settings?: Partial<ExportSettings>;
  fps?: [number, number];
  width?: number;
  height?: number;
  /** A real media file (base64) used instead of the test pattern, 1 s long: exercises the production decoder. */
  realMedia?: { base64: string; name: string };
  /** Cancel after this many progress events (to test cancel). */
  cancelAfterProgress?: number;
}
export interface HarnessOutcome {
  ok: boolean;
  code?: string;
  message?: string;
  mime?: string;
  fileBytes?: number;
  stats?: ExportStats;
  warnings?: string[];
  sha256?: string;
  head?: number[];
  progressEvents: number;
  lastProgress?: { framesDone: number; totalFrames: number; fraction: number; etaMs: number | null; phase: string };
  /** Bytes left in OPFS under overcut-exports/ after the run. */
  leftoverFiles: number;
  /** The encoded file, in 4 MiB base64 slices, only when `keep` was asked (manual verification). */
  slices?: string[];
}

async function opfsFileCount(): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("overcut-exports");
    let n = 0;
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) n += name ? 1 : 0;
    return n;
  } catch {
    return 0;
  }
}

async function sha256(file: File): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function runHarness(engine: Engine, run: HarnessRun, keep = false): Promise<HarnessOutcome> {
  const project = patternProject(run.seconds, { fps: run.fps, width: run.width, height: run.height });
  const sources: Record<string, Blob> = {};
  if (run.realMedia) {
    const m = project.media[0]!;
    m.uri = `file:${run.realMedia.name}`;
    m.name = run.realMedia.name;
    sources[m.id] = new Blob([Uint8Array.from(atob(run.realMedia.base64), (c) => c.charCodeAt(0))], { type: "video/webm" });
  }
  await engine.editing.open(project);
  const out: HarnessOutcome = { ok: false, progressEvents: 0, leftoverFiles: 0 };
  try {
    const job = await engine.export.start({ sequence: hex(3), ...(run.realMedia ? { sources } : {}), ...run.settings });
    job.onProgress((p) => {
      out.progressEvents++;
      out.lastProgress = { framesDone: p.framesDone, totalFrames: p.totalFrames, fraction: p.fraction, etaMs: p.etaMs, phase: p.phase };
      if (run.cancelAfterProgress !== undefined && out.progressEvents === run.cancelAfterProgress) job.cancel();
    });
    const r = await job.result;
    const file = await r.file();
    Object.assign(out, { ok: true, mime: r.mime, fileBytes: file.size, stats: r.stats, warnings: r.warnings, sha256: await sha256(file), head: Array.from(new Uint8Array(await file.slice(0, 32).arrayBuffer())) });
    if (keep) {
      out.slices = [];
      for (let o = 0; o < file.size; o += 4 << 20) {
        const bytes = new Uint8Array(await file.slice(o, o + (4 << 20)).arrayBuffer());
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        out.slices.push(btoa(s));
      }
    }
    await r.remove();
  } catch (e) {
    out.code = e instanceof ExportError ? e.code : "unknown";
    out.message = e instanceof Error ? e.message : String(e);
  }
  out.leftoverFiles = await opfsFileCount();
  return out;
}

export function ExportHarness() {
  const [status, setStatus] = useState("starting");
  useEffect(() => {
    void createEngine().then((engine) => {
      (window as unknown as { __exportHarness: unknown }).__exportHarness = { run: (r: HarnessRun, keep?: boolean) => runHarness(engine, r, keep), backend: engine.backend };
      setStatus("ready");
    });
  }, []);
  return <pre data-testid="export-harness">{status}</pre>;
}
