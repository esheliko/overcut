/** The phone's bottom tool strip (UX r14): which tools it offers for what is selected. Pure; the view is `ToolStrip.tsx`. */

/** Asks the shell to show a Details tab for the selected clip: the toolbar's Speed and Crop, the phone strip's Edit tools. `focus: "crop"` also puts the cursor on the first crop field. */
export const DETAILS_EVENT = "overcut:details";
export interface DetailsRequest { tab: "video" | "speed"; focus?: "crop" }
let pending: DetailsRequest | null = null;
/** Ask for a Details tab. The panel may not be on screen yet (a phone sheet that is closed), so the request also waits for it: `takeDetailsRequest`. */
export function requestDetails(d: DetailsRequest): void { pending = d; window.dispatchEvent(new CustomEvent(DETAILS_EVENT, { detail: d })); }
/** The request nobody has shown yet (the panel took it when it mounted), once. */
export function takeDetailsRequest(): DetailsRequest | null { const d = pending; pending = null; return d; }

/** Names from `icons.tsx` (this file stays free of the React icon module so the unit tests can load it; the strip checks the names at compile time). */
export type StripIcon = "media" | "overlay" | "split" | "canvas" | "edit" | "chevronLeft" | "speed" | "crop" | "duplicate" | "trash" | "unlink" | "keyframe";
export type StripId = "media" | "overlay" | "split" | "canvas" | "edit" | "back" | "speed" | "crop" | "duplicate" | "delete" | "detach" | "keyframe";
export interface StripTool { id: StripId; icon: StripIcon; /** i18n key of the visible label (and the accessible name). */ label: string; /** i18n key of a shorter visible text when the label is long (the accessible name stays the full label). */ short?: string; /** Registry id of the shortcut, when it has one (the tooltip shows it). */ key?: string }

const T: Record<StripId, StripTool> = {
  media: { id: "media", icon: "media", label: "tool.media.label" },
  overlay: { id: "overlay", icon: "overlay", label: "timeline.addMedia.overlay", short: "timeline.addMedia.overlay.short" },
  split: { id: "split", icon: "split", label: "timeline.split", short: "strip.split", key: "edit.split" },
  canvas: { id: "canvas", icon: "canvas", label: "strip.canvas" },
  edit: { id: "edit", icon: "edit", label: "tool.edit.label" },
  back: { id: "back", icon: "chevronLeft", label: "strip.back" },
  speed: { id: "speed", icon: "speed", label: "timeline.speed" },
  crop: { id: "crop", icon: "crop", label: "timeline.crop" },
  duplicate: { id: "duplicate", icon: "duplicate", label: "timeline.duplicate", key: "edit.duplicate" },
  delete: { id: "delete", icon: "trash", label: "timeline.delete", key: "edit.delete" },
  detach: { id: "detach", icon: "unlink", label: "timeline.unlink", short: "strip.detach" },
  keyframe: { id: "keyframe", icon: "keyframe", label: "strip.keyframe", key: "clip.keyframeAtPlayhead" },
};

/** Nothing selected: the global tools. A clip selected: a way back, then the tools of that clip. Edit is in both (it is the Details sheet). */
export function stripTools(sel: { count: number; linked: boolean; overlay: boolean }): StripTool[] {
  if (sel.count === 0) return [T.media, ...(sel.overlay ? [T.overlay] : []), T.split, T.canvas, T.edit];
  return [T.back, T.edit, T.split, T.speed, T.crop, T.duplicate, T.delete, ...(sel.linked ? [T.detach] : []), T.keyframe];
}
