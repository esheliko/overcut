import type { SVGProps } from "react";

/** circle(cx, cy, r) as a path, so every icon is one stroke-only <path>. */
const c = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
  media: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM10 9l5 3-5 3z",
  audio: `M9 18V6l10-2v12${c(6, 18, 3)}${c(16, 16, 3)}`,
  text: "M5 7V5h14v2M12 5v14M9 19h6",
  captions: "M3 6h18v12H3zM7 11h4M13 11h4M7 14.5h10",
  effects: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  transitions: "M3 6l7 6-7 6zM21 6l-7 6 7 6z",
  filters: `${c(9, 14, 5)}${c(15, 14, 5)}${c(12, 9, 5)}`,
  stickers: `${c(12, 12, 9)}M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5v.5M15 9.5v.5`,
  edit: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  pencil: "M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5ZM15 5l4 4",
  tag: `M3 12V4h8l10 10-8 8zM7.5 8v.5`,
  play: "M8 5v14l11-7z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  back: "M6 5v14M19 5L9 12l10 7z",
  forward: "M18 5v14M5 5l10 7-10 7z",
  stepBack: "M16 6v12l-8-6z",
  stepForward: "M8 6v12l8-6z",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  split: `M12 3v18${c(5, 6, 2.5)}${c(5, 18, 2.5)}M7.5 7.5L12 12M7.5 16.5L12 12M12 12l8-6M12 12l8 6`,
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  export: "M12 15V3M7 8l5-5 5 5M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4",
  more: `${c(5, 12, 1.4)}${c(12, 12, 1.4)}${c(19, 12, 1.4)}`,
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  minus: "M5 12h14",
  fit: "M4 6v12M20 6v12M8 12h8M8 12l3-3M8 12l3 3M16 12l-3-3M16 12l-3 3",
  video: "M3 6h12v12H3zM15 10l6-3v10l-6-3z",
  search: `${c(11, 11, 6)}M20 20l-4.5-4.5`,
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  theme: `${c(12, 12, 9)}M12 3v18M12 3a9 9 0 0 1 0 18`,
  check: "M5 12.5l4.5 4.5L19 7",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  share: `${c(18, 5, 2.5)}${c(6, 12, 2.5)}${c(18, 19, 2.5)}M8.2 10.8l7.6-4.6M8.2 13.2l7.6 4.6`,
  copy: "M9 9h11v11H9zM5 15V4h10",
  duplicate: "M4 4h10v10H4zM10 10h10v10H10z",
  unlink: "M9.5 14.5l-2 2a3.5 3.5 0 0 1-5-5l2-2M14.5 9.5l2-2a3.5 3.5 0 0 1 5 5l-2 2M9 15l1.5-1.5M15 9l-1.5 1.5M4 4l3 3M20 20l-3-3",
  cut: `${c(6, 18, 2.5)}${c(18, 18, 2.5)}M7.8 16.2L17 4M16.2 16.2L7 4`,
  paste: "M9 4h6v3H9zM7 5.5H5v15h14v-15h-2",
  timing: `${c(12, 13, 8)}M12 9v4l3 2M9 2h6`,
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  canvas: "M3 7h18v10H3zM7 3v4M17 3v4M7 17v4M17 17v4",
  tracks: "M4 6h12M4 12h9M4 18h12M19 8v8M15 12h8",
  trackOptions: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  rippleDelete: "M3 6h8v12H3zM15 12h6M18 9l3 3-3 3M5 9l4 6M9 9l-4 6",
  closeGap: "M3 5v14M21 5v14M6 12h4M18 12h-4M9 9l3 3-3 3M15 9l-3 3 3 3",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4",
  keyboard: "M3 6.5h18v11H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  shield: "M12 3l8 3v6c0 4.7-3.4 7.6-8 9-4.6-1.4-8-4.3-8-9V6z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  chevronDown: "M6 9l6 6 6-6",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  warn: "M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.2v.3",
  info: `${c(12, 12, 9)}M12 11v5.5M12 7.6v.3`,
  reset: "M4 12a8 8 0 1 0 2.6-5.9M4 4.5V9h4.5",
  ratioPortrait: "M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3z",
  ratioLandscape: "M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16V8a1.5 1.5 0 0 1 1.5-1.5z",
  ratioSquare: "M6.5 4.5h11A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V6a1.5 1.5 0 0 1 1.5-1.5z",
  smallFile: "M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v4h4M9.5 15.5l2.5 2.5 2.5-2.5M12 11.5V18",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  fullscreenExit: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  overlay: "M3 5h18v14H3zM12 11.5h6.5v5H12z",
  speed: "M4 18a8 8 0 1 1 16 0M12 18l4-6M7 18h.01M12 10v.01M17 18h.01",
  crop: "M7 3v14h14M3 7h14v14",
  magnet: "M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4zM5 8h4M15 8h4",
  keyframe: "M12 3l9 9-9 9-9-9z",
  toolSelect: "M5 3l14 8-6.2 1.6L9.6 19z",
  toolRipple: "M3 6h8v12H3zM15 8l6 4-6 4",
  toolRoll: "M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
  toolSlip: "M3 7h18v10H3zM9 12h6M12 9l3 3-3 3",
  toolSlide: "M7 6l-4 6 4 6M17 6l4 6-4 6M9 12h6",
  loop: "M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4",
} as const;

/** The path data of every icon, by name (tests pin an icon's shape through it). */
export const ICON_PATHS = PATHS;

export type IconName = keyof typeof PATHS;

/** One rule (docs/features/design-system.md): the transport (play, pause, skip, frame step) is filled; every other icon is a 1.7 px outline. */
const TRANSPORT: ReadonlySet<IconName> = new Set<IconName>(["play", "pause", "back", "forward", "stepBack", "stepForward"]);

export function Icon({ name, size = 22, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const filled = TRANSPORT.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
