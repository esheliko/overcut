/** Overview bar maths: a thin strip showing the whole project with a draggable window for what the timeline shows. Pure, no DOM. */
import { clamp, clampPps, END_PAD, gut, type View } from "./view";

/** Narrowest the window may be dragged to (px), so a handle is always grabbable. */
export const MIN_WINDOW = 12;
/** Width of an edge handle (px): grabbing within it resizes (zooms) instead of panning. */
export const EDGE = 10;

/** Seconds the bar spans: the project length, independent of the zoom so the clips in the bar stay put while zooming. */
export const overviewSpan = (_v: View, lengthSec: number) => Math.max(1, lengthSec);

/** The whole project already fits the timeline width: the bar is hidden. */
export const fitsView = (v: View, lengthSec: number) => lengthSec * v.pps + END_PAD <= v.width - gut(v) + 0.5;

export interface Win { x0: number; x1: number }

/** The window (px inside a bar `barW` wide) for the current view. */
export function windowOf(v: View, lengthSec: number, barW: number): Win {
  const span = overviewSpan(v, lengthSec);
  const t0 = v.scrollX / v.pps, t1 = t0 + (v.width - gut(v)) / v.pps;
  const x0 = clamp((t0 / span) * barW, 0, barW - MIN_WINDOW);
  const x1 = clamp((t1 / span) * barW, x0 + MIN_WINDOW, barW);
  return { x0, x1 };
}

/** What a press at bar x lands on: an edge handle, the window body, or the track outside it (jump). */
export function partAt(w: Win, x: number): "left" | "right" | "body" | "outside" {
  const edge = Math.min(EDGE, (w.x1 - w.x0) / 3);
  if (x < w.x0 - 2 || x > w.x1 + 2) return "outside";
  if (x <= w.x0 + edge) return "left";
  if (x >= w.x1 - edge) return "right";
  return "body";
}

/** Scroll offset (px) that puts the window's left edge at bar x. */
export function scrollForWindowLeft(v: View, lengthSec: number, barW: number, left: number): number {
  return (left / barW) * overviewSpan(v, lengthSec) * v.pps;
}

/** Pan: the window keeps its grab offset `grab` (px from its left edge to the pointer) while the pointer is at `x`. */
export function panTo(v: View, lengthSec: number, barW: number, x: number, grab: number): number {
  return Math.max(0, scrollForWindowLeft(v, lengthSec, barW, x - grab));
}

/** Resize: an edge dragged to bar x while the other edge stays put. Returns the new zoom and scroll for the timeline. */
export function resizeTo(v: View, lengthSec: number, barW: number, w: Win, edge: "left" | "right", x: number): { pps: number; scrollX: number } {
  const span = overviewSpan(v, lengthSec);
  const secPerPx = span / barW;
  const fixed = edge === "left" ? w.x1 : w.x0;
  const moved = edge === "left" ? clamp(x, 0, fixed - MIN_WINDOW) : clamp(x, fixed + MIN_WINDOW, barW);
  const winSec = Math.abs(fixed - moved) * secPerPx;
  const pps = clampPps((v.width - gut(v)) / winSec);
  const left = Math.min(fixed, moved) * secPerPx;
  return { pps, scrollX: Math.max(0, left * pps) };
}
