import { useRef, type PointerEvent as RPointerEvent } from "react";
import type { Clip } from "@app/engine-client";
import { placeLayer } from "@app/engine-client";
import { newGestureKey, setFields, valuesOf, type NumKey } from "../inspector/transformModel";
import "../inspector/inspector.css";

type Mode = "move" | "scale" | "rotate";
interface Drag {
  mode: Mode;
  key: number;
  px: number;
  py: number;
  /** Pivot in client px. */
  cx: number;
  cy: number;
  v: ReturnType<typeof valuesOf>;
  box: DOMRect;
}

interface Props {
  clip: Clip;
  /** The sequence (canvas) size in pixels. */
  canvas: { width: number; height: number };
  /** Upright size of the clip's picture; the canvas size when unknown. */
  picture?: { width: number; height: number };
  /** The element that has the preview's aspect ratio; the handles live inside it. */
  boxRef: { current: HTMLElement | null };
  onEdit(next: ReturnType<typeof setFields>, key: number): void;
}

/**
 * Drag handles for the selected clip over the preview: drag the picture to move it, a corner to scale (uniform, about the pivot), the round
 * handle to rotate. Targets are 44 px. One drag is one undo step (one coalescing key). Math is in `inspector/transformModel`.
 */
export function TransformHandles({ clip, canvas, picture, boxRef, onEdit }: Props) {
  const drag = useRef<Drag | null>(null);
  const tr = clip.transform;
  const v = valuesOf(tr);
  const display = picture ?? canvas;
  const p = placeLayer(
    { position: [v.position_x, v.position_y], scale: [v.scale_x, v.scale_y], rotation: v.rotation, anchor: [tr?.anchor_x?.value ?? 0, tr?.anchor_y?.value ?? 0], crop: [v.crop_left, v.crop_top, v.crop_right, v.crop_bottom], flip: [!!tr?.flip_h, !!tr?.flip_v], fit: tr?.fit ?? "contain" },
    display,
    canvas,
  );
  const w = display.width * p.scale[0];
  const h = display.height * p.scale[1];
  // Visible rectangle: crop shifts its centre along the rotated axes.
  const [l, t, r, b] = p.crop;
  const [s, c] = [Math.sin(p.angle), Math.cos(p.angle)];
  const [ox, oy] = [(l - r) * 0.5 * w, (t - b) * 0.5 * h];
  const cxs = p.center[0] + ox * c - oy * s;
  const cys = p.center[1] + ox * s + oy * c;
  const vw = Math.max(0.001, w * (1 - l - r));
  const vh = Math.max(0.001, h * (1 - t - b));

  const start = (mode: Mode) => (e: RPointerEvent<HTMLElement>) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pivotX = box.left + (0.5 + v.position_x) * box.width;
    const pivotY = box.top + (0.5 + v.position_y) * box.height;
    drag.current = { mode, key: newGestureKey(), px: e.clientX, py: e.clientY, cx: pivotX, cy: pivotY, v, box };
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    let patch: Partial<Record<NumKey, number>>;
    if (d.mode === "move") {
      patch = { position_x: d.v.position_x + (e.clientX - d.px) / d.box.width, position_y: d.v.position_y + (e.clientY - d.py) / d.box.height };
    } else if (d.mode === "scale") {
      const d0 = Math.hypot(d.px - d.cx, d.py - d.cy) || 1;
      const k = Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d0;
      patch = { scale_x: d.v.scale_x * k, scale_y: d.v.scale_y * k };
    } else {
      const a0 = Math.atan2(d.py - d.cy, d.px - d.cx);
      const a1 = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
      let deg = d.v.rotation + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      patch = { rotation: deg };
    }
    onEdit(setFields(tr, patch), d.key);
  };
  const end = () => { drag.current = null; };
  const evt = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const pc = (x: number, total: number) => `${(x / total) * 100}%`;

  return (
    <div className="th" aria-hidden={false} style={{ left: pc(cxs, canvas.width), top: pc(cys, canvas.height), width: pc(vw, canvas.width), height: pc(vh, canvas.height), transform: `translate(-50%, -50%) rotate(${p.angle}rad)` }}>
      <div className="th-body" data-testid="transform-body" onPointerDown={start("move")} {...evt} />
      {(["nw", "ne", "se", "sw"] as const).map((k) => (
        <span key={k} className={`th-h th-${k}`} data-testid={`transform-scale-${k}`} onPointerDown={start("scale")} {...evt} />
      ))}
      <span className="th-rot" data-testid="transform-rotate" onPointerDown={start("rotate")} {...evt} />
    </div>
  );
}
