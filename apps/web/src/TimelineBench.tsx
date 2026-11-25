/** S8 benchmark page: open `/#timeline-bench` (production or dev build). Drives scripted pan and zoom over a 1000-clip, 20-track project
 *  and reports frame intervals and draw time. Automated by `node tests/perf/timeline-bench.mjs`. Not linked from the UI. */
import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { createEngine } from "@app/engine-client";
import { MediaCache, MemoryStore } from "./media/cache";
import { FakeMediaHost } from "./media/host";
import { MediaLayer } from "./timeline/media-layer";
import { fixtureProject } from "./timeline/fixture";
import { buildScene } from "./timeline/scene";
import { TimelineCanvas, type CanvasHandle } from "./timeline/TimelineCanvas";
import { GUTTER, LANE, RULER, zoomAt } from "./timeline/view";

type Phase = { name: string; fps: number; p95Ms: number; maxMs: number; drawAvgMs: number; drawP95Ms: number; flushAvgMs: number; clipsDrawn: number; frames: number };
const q = (a: Float64Array, p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))]!;

export function TimelineBench() {
  const scene = useMemo(() => buildScene(fixtureProject({ tracks: 20, clipsPerTrack: 50 })), []);
  const handle = useRef<CanvasHandle | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const edits = useRef<unknown[]>([]);
  // `#timeline-bench` = placeholders (the S8 numbers); `#timeline-bench&media` = real waveforms and thumbnails from the engine's peaks.
  const withMedia = location.hash.includes("media");
  const [layer, setLayer] = useState<MediaLayer | undefined>();
  const [ready0, setReady0] = useState(!withMedia);
  useEffect(() => {
    if (!withMedia) return;
    void createEngine().then((e) => { setLayer(new MediaLayer(e, new FakeMediaHost({ seconds: 120 }), new MediaCache(new MemoryStore()))); setReady0(true); });
  }, [withMedia]);
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

    /** Input-to-paint while dragging clips: per pointermove, the synchronous work to produce the frame (event handler + draw + raster flush).
     *  Frame alignment (waiting for vsync) is excluded: that is the display, not the code. `all` drags a selection of every clip. */
    const drag = async (all: boolean, moves = 240) => {
      const el = h.el, probe = el.getContext("2d")!;
      h.view.scrollX = 0; h.view.scrollY = 0; h.view.pps = 40; h.draw();
      const fire = (type: string, x: number, y: number, extra: PointerEventInit = {}) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "mouse", bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, buttons: 1, ...extra }));
      };
      if (all) { el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); }
      const x0 = (h.view.gutter ?? GUTTER) + 60, y0 = RULER + LANE / 2;
      fire("pointerdown", x0, y0);
      await new Promise((r) => requestAnimationFrame(r));
      const dt = new Float64Array(moves);
      for (let i = 0; i < moves; i++) {
        const t0 = performance.now();
        fire("pointermove", x0 + 10 + Math.round(24 * Math.sin(i / 12)), y0 + (i % 80 < 40 ? 0 : LANE));
        h.draw();
        probe.getImageData(0, 0, 1, 1);
        dt[i] = performance.now() - t0;
      }
      fire("pointerup", x0, y0, { buttons: 0 });
      const s = dt.slice().sort();
      return { clips: scene.clipCount, selected: all ? scene.clipCount : 1, p50Ms: q(s, 0.5), p95Ms: q(s, 0.95), maxMs: s[s.length - 1]!, moves };
    };
    (window as unknown as { __timelineDragBench: () => Promise<unknown> }).__timelineDragBench = async () => ({ single: await drag(false), all: await drag(true), edits: edits.current.length });
  }, [scene]);
  useEffect(() => {
    const w = window as unknown as { __mediaIdle?: () => Promise<{ stats: unknown; thumbs: unknown }> };
    w.__mediaIdle = layer ? async () => { await layer.waveforms.idle(); return { stats: layer.waveforms.stats, thumbs: layer.thumbs.stats }; } : undefined;
  }, [layer]);
  if (!ready0) return null;
  return (
    <div style={{ position: "fixed", inset: 0, display: "grid" }}>
      <div style={{ position: "relative" }}>
        <TimelineCanvas scene={scene} fps={30} frame={0} endFrame={30 * 3600} playing={false} zoom={40} onFrame={() => undefined} onZoom={() => undefined} summary="Benchmark timeline." selected={selected} onSelect={setSelected} onEdit={(ops) => edits.current.push(ops)} onReady={ready} media={layer} />
      </div>
    </div>
  );
}
