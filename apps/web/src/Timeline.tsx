import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Icon, type IconName } from "./icons";
import { FPS, frameAt, rulerLabel, rulerStep } from "./timecode";

export const TIMELINE_SECONDS = 60;
export const END_FRAME = TIMELINE_SECONDS * FPS;

const LANES: { id: string; label: string; icon: IconName }[] = [
  { id: "text", label: "Text and overlays", icon: "text" },
  { id: "video", label: "Video", icon: "video" },
  { id: "audio", label: "Audio", icon: "audio" },
];

type Props = {
  frame: number;
  playing: boolean;
  zoom: number;
  onFrame: (f: number) => void;
  onZoom: (z: number) => void;
  onSoon: (what: string) => void;
};

export function Timeline({ frame, playing, zoom, onFrame, onZoom, onSoon }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const width = TIMELINE_SECONDS * zoom;
  const step = rulerStep(zoom);
  const ticks = Array.from({ length: Math.floor(TIMELINE_SECONDS / step) + 1 }, (_, i) => i * step);
  const x = (frame / FPS) * zoom;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const sc = scroller.current;
    if (!playing || !sc) return;
    if (x > sc.scrollLeft + sc.clientWidth - 48 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 96);
  }, [x, playing]);

  const seek = (e: PointerEvent) => {
    const box = content.current?.getBoundingClientRect();
    if (box) onFrame(frameAt(e.clientX - box.left, zoom, END_FRAME));
  };
  const down = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e);
  };
  const move = (e: PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e);
  };
  const key = (e: KeyboardEvent) => {
    const big = e.shiftKey ? FPS : 1;
    const to = e.key === "ArrowRight" ? frame + big : e.key === "ArrowLeft" ? frame - big : e.key === "Home" ? 0 : e.key === "End" ? END_FRAME : null;
    if (to === null) return;
    e.preventDefault();
    onFrame(Math.min(END_FRAME, Math.max(0, to)));
  };

  return (
    <section className="timeline" aria-label="Timeline" data-testid="panel-timeline">
      <div className="tl-bar">
        <div className="tl-group" role="toolbar" aria-label="Edit">
          <button className="icon-btn" aria-label="Undo" title="Undo" onClick={() => onSoon("Undo arrives with editing in M1")}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label="Redo" title="Redo" onClick={() => onSoon("Redo arrives with editing in M1")}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label="Split at playhead" title="Split at playhead" onClick={() => onSoon("Split arrives with editing in M1")}><Icon name="split" /></button>
          <button className="icon-btn" aria-label="Delete" title="Delete" onClick={() => onSoon("Delete arrives with editing in M1")}><Icon name="trash" /></button>
        </div>
        <label className="zoom">
          <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => onZoom(Math.max(10, zoom - 10))}><Icon name="minus" size={18} /></button>
          <input type="range" min={10} max={240} step={1} value={zoom} onChange={(e) => onZoom(Number(e.target.value))} aria-label="Timeline zoom" />
          <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => onZoom(Math.min(240, zoom + 10))}><Icon name="plus" size={18} /></button>
        </label>
      </div>

      <div className="tl-scroll" ref={scroller}>
        <div className="tl-grid" style={{ width: `calc(var(--gutter) + ${width}px + 6rem)` }}>
          <div className="tl-content" ref={content} style={{ width: width + 96 }}>
            <div
              className="tl-ruler"
              role="slider"
              tabIndex={0}
              aria-label="Playhead position"
              aria-valuemin={0}
              aria-valuemax={END_FRAME}
              aria-valuenow={frame}
              aria-valuetext={`${(frame / FPS).toFixed(2)} seconds`}
              onPointerDown={down}
              onPointerMove={move}
              onKeyDown={key}
            >
              {ticks.map((s) => (
                <span key={s} className="tick" style={{ left: s * zoom }}>{rulerLabel(s)}</span>
              ))}
            </div>
            {LANES.map((l) => (
              <div key={l.id} className="lane" data-lane={l.id} onPointerDown={down} onPointerMove={move}>
                {l.id === "video" && (
                  <button className="lane-add" onPointerDown={(e) => e.stopPropagation()} onClick={() => onSoon("Adding clips arrives in M1: import, then drag to the timeline")}>
                    <Icon name="plus" size={18} /> Add media to start
                  </button>
                )}
              </div>
            ))}
            <div className="playhead" style={{ transform: `translateX(${x}px)` }} aria-hidden="true" />
          </div>
          <div className="tl-heads">
            {LANES.map((l) => (
              <div key={l.id} className="head" title={l.label}><Icon name={l.icon} size={18} /><span className="sr-only">{l.label}</span></div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
