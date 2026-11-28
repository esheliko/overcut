import type { ReactNode } from "react";
import type { Clip } from "@app/engine-client";

/**
 * THE SLOT for the sound controls of the Audio tab (Volume, Fade in, Fade out). UX r16 lane B makes the tab and renders this component under the
 * "Audio clip" card; lane D replaces this body with the real controls (a `Section` per control group, or plain rows in `.insp`), nothing else in
 * the Audio tab needs to change. `clips` are the selected sounds (one for the Audio tab of a single clip; several for a multi-sound selection).
 */
export function AudioControls({ clips }: { clips: readonly Clip[] }): ReactNode {
  void clips;
  return null;
}
