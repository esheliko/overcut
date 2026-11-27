/**
 * Cursor per edit tool (M2 UX r12): the pointer says which tool is armed and what a drag will do, so a pro sees ripple / roll / slip / slide before pressing.
 * Small inline SVGs (white shape, dark outline: readable on any clip colour), hot spot in the middle, a stock cursor as the fallback.
 */
import type { Tool } from "./ripple";

const svg = (body: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${body}</svg>`)}") 12 12`;
const shape = (d: string): string => `<path d='${d}' fill='white' stroke='#111' stroke-width='1.4' stroke-linejoin='round'/>`;

/** Ripple: an edge bar with an arrow that pushes everything after it. */
const RIPPLE = svg(shape("M5 4h3v16H5zM10 9h5V5.5L21 12l-6 6.5V15h-5z"));
/** Slip: the clip's window (two brackets) with the picture sliding inside. */
const SLIP = svg(shape("M3 5h3v2H5v10h1v2H3zM21 5h-3v2h1v10h-1v2h3zM8 12l3-3v2h2V9l3 3-3 3v-2h-2v2z"));
/** Slide: the whole clip moves between its neighbours. */
const SLIDE = svg(shape("M2 12l4-4v3h3V8l3 4-3 4v-3H6v3zM13 6h9v12h-9z"));

const FALLBACK: Record<Exclude<Tool, "select">, string> = { ripple: "ew-resize", roll: "col-resize", slip: "ew-resize", slide: "ew-resize" };
const URLS: Record<Exclude<Tool, "select">, string> = { ripple: RIPPLE, roll: "", slip: SLIP, slide: SLIDE };

/** The CSS cursor of a non-select tool over a clip (edge or body). */
export function toolCursor(tool: Tool): string {
  if (tool === "select") return "";
  const u = URLS[tool];
  return u ? `${u}, ${FALLBACK[tool]}` : FALLBACK[tool];
}
