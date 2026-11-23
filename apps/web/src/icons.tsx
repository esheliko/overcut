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
  play: "M8 5v14l11-7z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  back: "M6 5v14M19 5L9 12l10 7z",
  forward: "M18 5v14M5 5l10 7-10 7z",
  stepBack: "M15 5l-7 7 7 7",
  stepForward: "M9 5l7 7-7 7",
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
  canvas: "M3 7h18v10H3zM7 3v4M17 3v4M7 17v4M17 17v4",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const filled = name === "play" || name === "pause";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
