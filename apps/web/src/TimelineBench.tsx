/** S8 benchmark page: open `/#timeline-bench` (production or dev build). Drives scripted pan and zoom over a 1000-clip, 20-track project
 *  and reports frame intervals and draw time. Automated by `node tests/perf/timeline-bench.mjs`. Not linked from the UI. */
import { useCallback, useMemo, useRef } from "react";
import { fixtureProject } from "./timeline/fixture";
import { buildScene } from "./timeline/scene";
import { TimelineCanvas, type CanvasHandle } from "./timeline/TimelineCanvas";
import { zoomAt } from "./timeline/view";

type Phase = { name: string; fps: number; p95Ms: number; maxMs: number; drawAvgMs: number; drawP95Ms: number; flushAvgMs: number; clipsDrawn: number; frames: number };
const q = (a: Float64Array, p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))]!;

export function TimelineBench() {
  const scene = useMemo(() => buildScene(fixtureProject({ tracks: 20, clipsPerTrack: 50 })), []);
  const handle = useRef<CanvasHandle | null>(null);
  const ready = useCallback((h: CanvasHandle) => {
    handle.current = h;
    const phases = ["pan", "zoom", "pan+zoom"] as const;
    const run = async (frames = 240): Promise<{ clips: number; tracks: number; phases: Phase[] }> => {
      const out: Phase[] = [];
      for (const name of phases) {
        h.view.scrollX = 0; h.view.scrollY = 0; h.view.pps = 40;
        const dt = new Float64Array(frames), dr = new Float64Array(frames), fl = new Float64Array(frames);
        const probe = document.querySelector<HTMLCanvasElement>("canvas")!.getContext("2d")!;
        let last = await new Promise<number>((r) => requestAnimationFrame(r));
        let clipsDrawn = 0;
        for (let i = 0; i < frames; i++) {
          const now = await new Promise<number>((r) => requestAnimationFrame(r));
          dt[i] = now - last; last = now;
          const v = h.view;
          if (name !== "zoom") { v.scrollX += 14; v.scrollY = (Math.sin(i / 20) + 1) * 150; }
          if (name !== "pan") zoomAt(v, 40 * Math.pow(6, Math.sin(i / 25)), v.width / 2);
          const t0 = performance.now();
          h.draw();
          dr[i] = performance.now() - t0;
          probe.getImageData(0, 0, 1, 1); // forces the queued canvas commands to rasterize: the honest cost of a frame
          fl[i] = performance.now() - t0;
          clipsDrawn = Math.max(clipsDrawn, h.stats.clipsDrawn);
        }
        const sd = Float64Array.from(dt).sort(), sr = Float64Array.from(dr).sort();
        const mean = dt.reduce((a, b) => a + b, 0) / frames;
        out.push({ name, fps: 1000 / mean, p95Ms: q(sd, 0.95), maxMs: sd[frames - 1]!, drawAvgMs: dr.reduce((a, b) => a + b, 0) / frames, drawP95Ms: q(sr, 0.95), flushAvgMs: fl.reduce((a, b) => a + b, 0) / frames, clipsDrawn, frames });
      }
      return { clips: scene.clipCount, tracks: scene.trackCount, phases: out };
    };
    (window as unknown as { __timelineBench: typeof run }).__timelineBench = run;
  }, [scene]);
  return (
    <div style={{ position: "fixed", inset: 0, display: "grid" }}>
      <div style={{ position: "relative" }}>
        <TimelineCanvas scene={scene} fps={30} frame={0} endFrame={30 * 3600} playing={false} zoom={40} onFrame={() => undefined} onZoom={() => undefined} summary="Benchmark timeline." onReady={ready} />
      </div>
    </div>
  );
}
