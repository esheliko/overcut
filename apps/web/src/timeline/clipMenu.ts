/** The clip context menu (T-03): which rows it offers and which of them can run for the current selection. Pure; `Timeline.tsx` runs the rows through the same commands as the
 *  toolbar and the keys (split, delete, ripple delete, duplicate, unlink) and the Speed inspector's edit (speed presets). */
import { SPEED_PRESETS } from "../inspector/speedModel";

export type ClipMenuId = "split" | "duplicate" | "delete" | "rippleDelete" | "unlink" | "mute" | `speed:${number}`;
/** Why a row is unavailable: an i18n key suffix (`timeline.why.<reason>`). */
export type ClipMenuWhy = "select" | "linked" | "one" | "still" | "locked" | "silent";
export interface ClipMenuItem { id: ClipMenuId; section?: "clip" | "speed"; disabled: boolean; why?: ClipMenuWhy }

export interface ClipMenuState {
  /** Clips selected (a linked picture and sound count as one). */
  clips: number;
  /** Any selected clip is linked to a partner. */
  anyLinked: boolean;
  /** Every selected clip lies on a locked track (nothing can be edited). */
  allLocked: boolean;
  /** The selection is a still picture (speed does not apply). */
  still: boolean;
  /** The selection has a sound to mute (an audio clip, or a picture with its linked sound), and every such sound is already muted. */
  sound: boolean;
  muted: boolean;
}

export function clipMenuItems(s: ClipMenuState): ClipMenuItem[] {
  const none = s.clips === 0;
  const edit = (id: ClipMenuId, section?: "clip"): ClipMenuItem => ({ id, section, disabled: none || s.allLocked, why: none ? "select" : s.allLocked ? "locked" : undefined });
  const speedWhy: ClipMenuWhy | undefined = none ? "select" : s.clips > 1 ? "one" : s.still ? "still" : s.allLocked ? "locked" : undefined;
  return [
    edit("split", "clip"), edit("duplicate"), edit("delete"), edit("rippleDelete"),
    { id: "unlink", disabled: none || !s.anyLinked, why: none ? "select" : !s.anyLinked ? "linked" : undefined },
    { id: "mute", disabled: none || !s.sound || s.allLocked, why: none ? "select" : !s.sound ? "silent" : s.allLocked ? "locked" : undefined },
    ...SPEED_PRESETS.map((x): ClipMenuItem => ({ id: `speed:${x}`, section: "speed", disabled: speedWhy !== undefined, why: speedWhy })),
  ];
}
