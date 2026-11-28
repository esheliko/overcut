import type { ReactNode } from "react";
import type { Clip } from "@app/engine-client";
import { AudioSection } from "./AudioSection";

/**
 * The sound controls of the Audio tab (Volume, Fade in, Fade out, Mute clip), rendered under the "Audio clip" card (UX r16 lanes B + D).
 * `AudioSection` reads the selection itself (a sound, or the linked sound of a picture), so `clips` only says that there is something to show.
 */
export function AudioControls({ clips }: { clips: readonly Clip[] }): ReactNode {
  return clips.length === 1 ? <AudioSection /> : null; // several sounds: Mute in the clip menu covers them; per-clip levels need one clip
}
