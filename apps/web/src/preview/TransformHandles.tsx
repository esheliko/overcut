import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import type { Clip } from "@app/engine-client";
import { placeLayer } from "@app/engine-client";
import { useI18n } from "../i18n";
import { currentKeymap } from "../commands/keymap";
import { resolveKey } from "../commands/registry";
import { newGestureKey, setFields, snapMove, snapRotation, valuesOf, type NumKey, type SnapGuides } from "../inspector/transformModel";
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
  /** The picture's axis-aligned box in canvas pixels when the drag began (centre and half sizes): what a move snaps. */
  rc: { cx: number; cy: number; hw: number; hh: number };
}

interface Props {
  clip: Clip;
  /** The sequence (canvas) size in pixels. */
  canvas: { width: number; height: number };
  /** Upright size of the clip's picture; the canvas size when unknown. */
  picture?: { width: number; height: number };
  /** The element that has the preview's aspect ratio; the handles live inside it. */
  boxRef: { current: HTMLElement | null };
  /** The playhead in ticks from the clip's start: an animated clip shows (and is dragged from) its values at that moment. */
  rel?: number;
  onEdit(next: ReturnType<typeof setFields>, key: number): void;
}

/**
 * Drag handles for the selected clip over the preview: drag the picture to move it, a corner to scale (uniform, about the pivot), the round
 * handle to rotate. Targets are 44 px. One drag is one undo step (one coalescing key). Math is in `inspector/transformModel`.
 */
export function TransformHandles({ clip, canvas, picture, boxRef, rel, onEdit }: Props) {
  const { t: tr18 } = useI18n();
  const drag = useRef<Drag | null>(null);
  /** An arrow-key burst: the values it started from, the total moved (canvas px) and the gesture key, so a run of presses is one undo step. It ends after a short pause. */
  const burst = useRef<{ key: number; v: ReturnType<typeof valuesOf>; x: number; y: number; timer: number } | null>(null);
  useEffect(() => () => { if (burst.current) window.clearTimeout(burst.current.timer); }, []);
  const [guides, setGuides] = useState<SnapGuides>({});
  const tr = clip.transform;
  const v = valuesOf(tr, rel);
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

  // Keep every handle inside the visible preview: a picture that fills the frame has its corners on the frame's edge, where half of a 44 px handle would be cut off
  // (phones). Each handle is pulled inwards by what sticks out; the shift is computed on screen and turned back into the rotated frame of the box.
  const rect = boxRef.current?.getBoundingClientRect();
  const kept = (lx: number, ly: number): { transform?: string } => {
    if (!rect || rect.width < 100 || rect.height < 100) return {};
    const k = rect.width / canvas.width, R = 22;
    const X = cxs * k + lx * c - ly * s, Y = cys * k + lx * s + ly * c;
    // The visible area is the stage view around the frame (it clips what sticks out), in the frame's coordinates.
    const vis = boxRef.current?.parentElement?.getBoundingClientRect() ?? rect;
    const x0 = vis.left - rect.left + R, x1 = vis.right - rect.left - R, y0 = vis.top - rect.top + R, y1 = vis.bottom - rect.top - R;
    const dx = Math.min(Math.max(X, x0), x1) - X, dy = Math.min(Math.max(Y, y0), y1) - Y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return {};
    return { transform: `translate(${(dx * c + dy * s).toFixed(1)}px, ${(-dx * s + dy * c).toFixed(1)}px)` };
  };
  const kw = rect ? (vw / 2) * (rect.width / canvas.width) : 0, kh = rect ? (vh / 2) * (rect.width / canvas.width) : 0;
  const corner = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] } as const;

  const start = (mode: Mode) => (e: RPointerEvent<HTMLElement>) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === "move") e.currentTarget.focus({ preventScroll: true }); // the arrows then nudge this picture
    e.currentTarget.setPointerCapture(e.pointerId);
    const pivotX = box.left + (0.5 + v.position_x) * box.width;
    const pivotY = box.top + (0.5 + v.position_y) * box.height;
    drag.current = { mode, key: newGestureKey(), px: e.clientX, py: e.clientY, cx: pivotX, cy: pivotY, v, box, rc: { cx: cxs, cy: cys, hw: (Math.abs(vw * c) + Math.abs(vh * s)) / 2, hh: (Math.abs(vw * s) + Math.abs(vh * c)) / 2 } };
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    let patch: Partial<Record<NumKey, number>>;
    if (d.mode === "move") {
      let [px, py] = [d.v.position_x + (e.clientX - d.px) / d.box.width, d.v.position_y + (e.clientY - d.py) / d.box.height];
      // Pull the picture onto the canvas centre / edges within 6 screen px (hold Alt to move freely); the guide lines show what it caught.
      let hit: SnapGuides = {};
      if (!e.altKey) {
        const sn = snapMove({ cx: d.rc.cx + (px - d.v.position_x) * canvas.width, cy: d.rc.cy + (py - d.v.position_y) * canvas.height, hw: d.rc.hw, hh: d.rc.hh }, canvas, (6 * canvas.width) / d.box.width);
        px += sn.dx / canvas.width; py += sn.dy / canvas.height; hit = sn.guides;
      }
      setGuides((g) => (g.x === hit.x && g.y === hit.y ? g : hit));
      patch = { position_x: px, position_y: py };
    } else if (d.mode === "scale") {
      const d0 = Math.hypot(d.px - d.cx, d.py - d.cy) || 1;
      const k = Math.hypot(e.clientX - d.cx, e.clientY - d.cy) / d0;
      patch = { scale_x: d.v.scale_x * k, scale_y: d.v.scale_y * k };
    } else {
      const a0 = Math.atan2(d.py - d.cy, d.px - d.cx);
      const a1 = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
      let deg = d.v.rotation + ((a1 - a0) * 180) / Math.PI;
      deg = snapRotation(deg, e.shiftKey); // right angles within 3 degrees, 15-degree steps with Shift
      patch = { rotation: deg };
    }
    onEdit(setFields(tr, patch), d.key);
  };
  const nudge = (e: RKeyboardEvent<HTMLElement>) => {
    const cmd = resolveKey(e.nativeEvent, "preview", currentKeymap())?.command;
    if (cmd?.c !== "pictureNudge") return;
    e.preventDefault();
    e.stopPropagation(); // the transport (arrows step the playhead) and the timeline keys must not also act on this press
    const b = burst.current ?? (burst.current = { key: newGestureKey(), v, x: 0, y: 0, timer: 0 });
    window.clearTimeout(b.timer);
    b.timer = window.setTimeout(() => { burst.current = null; }, 600);
    b.x += cmd.dx * cmd.px; b.y += cmd.dy * cmd.px;
    onEdit(setFields(tr, { position_x: b.v.position_x + b.x / canvas.width, position_y: b.v.position_y + b.y / canvas.height }), b.key);
  };
  // Two fingers anywhere on the preview scale and rotate the selected picture (r16 PHONE-1). Capture-phase listeners on the stage view, because the handles stop their own events;
  // the latest values and callback are read through a ref so the listeners are set up once per mounted gizmo.
  const live = useRef({ v, tr, onEdit });
  live.current = { v, tr, onEdit };
  useEffect(() => {
    const host = boxRef.current?.parentElement;
    if (!host) return;
    const fingers = new Map<number, { x: number; y: number }>();
    let pinch: { d0: number; a0: number; v: ReturnType<typeof valuesOf>; key: number } | null = null;
    const geom = () => { const [a, b] = [...fingers.values()]; return { d: Math.hypot(b!.x - a!.x, b!.y - a!.y) || 1, a: Math.atan2(b!.y - a!.y, b!.x - a!.x) }; };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (fingers.size === 2) {
        const g = geom();
        pinch = { d0: g.d, a0: g.a, v: live.current.v, key: newGestureKey() };
        drag.current = null; // the one-finger drag that came first ends: the pinch takes over
        setGuides((x) => (x.x === undefined && x.y === undefined ? x : {}));
      }
    };
    const move = (e: PointerEvent) => {
      const f = fingers.get(e.pointerId);
      if (!f) return;
      f.x = e.clientX; f.y = e.clientY;
      if (!pinch || fingers.size < 2) return;
      e.stopPropagation(); // the picture's own drag must not also move it
      const g = geom(), k = g.d / pinch.d0;
      const deg = snapRotation(pinch.v.rotation + ((g.a - pinch.a0) * 180) / Math.PI, false);
      live.current.onEdit(setFields(live.current.tr, { scale_x: pinch.v.scale_x * k, scale_y: pinch.v.scale_y * k, rotation: deg }), pinch.key);
    };
    const up = (e: PointerEvent) => { fingers.delete(e.pointerId); if (fingers.size < 2) pinch = null; };
    const prevTouch = host.style.touchAction;
    host.style.touchAction = "none"; // the browser must not take the two-finger gesture for page zoom
    host.addEventListener("pointerdown", down, true);
    host.addEventListener("pointermove", move, true);
    host.addEventListener("pointerup", up, true);
    host.addEventListener("pointercancel", up, true);
    return () => {
      host.style.touchAction = prevTouch;
      host.removeEventListener("pointerdown", down, true); host.removeEventListener("pointermove", move, true);
      host.removeEventListener("pointerup", up, true); host.removeEventListener("pointercancel", up, true);
    };
  }, [boxRef]);
  const end = () => { drag.current = null; setGuides((g) => (g.x === undefined && g.y === undefined ? g : {})); };
  const evt = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };
  const pc = (x: number, total: number) => `${(x / total) * 100}%`;

  return (
    <>
    {guides.x !== undefined && <div className="th-guide th-guide-v" data-testid="snap-guide-x" style={{ left: pc(guides.x * canvas.width, canvas.width) }} />}
    {guides.y !== undefined && <div className="th-guide th-guide-h" data-testid="snap-guide-y" style={{ top: pc(guides.y * canvas.height, canvas.height) }} />}
    <div className="th" aria-hidden={false} style={{ left: pc(cxs, canvas.width), top: pc(cys, canvas.height), width: pc(vw, canvas.width), height: pc(vh, canvas.height), transform: `translate(-50%, -50%) rotate(${p.angle}rad)` }}>
      <div className="th-body" data-testid="transform-body" role="group" tabIndex={0} aria-label={tr18("preview.pictureFrame")} onKeyDown={nudge} onPointerDown={start("move")} {...evt} />
      {(["nw", "ne", "se", "sw"] as const).map((k) => (
        <span key={k} className={`th-h th-${k}`} data-testid={`transform-scale-${k}`} style={kept(corner[k][0] * kw, corner[k][1] * kh)} onPointerDown={start("scale")} {...evt} />
      ))}
      <span className="th-rot" data-testid="transform-rotate" style={kept(0, -kh - 30)} onPointerDown={start("rotate")} {...evt} />
    </div>
    </>
  );
}
