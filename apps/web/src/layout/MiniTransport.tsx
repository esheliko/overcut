import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { COMMAND_EVENT } from "../commands/palette";
import { selectedVideoClip } from "../inspector/Inspector";
import { PROPS_OF, neighbourKey, relativeTicks, ticksPerFrame, ticksToFrame } from "../inspector/keyframeModel";
import { timecodeHMS } from "../preview/timing";
import { useProjectStore, useStore } from "../store/projectStore";

/**
 * The phone Edit sheet's sticky strip: the playhead time, play / pause and the previous / next keyframe of the selected clip, so the sheet can sit low
 * (the picture and the timeline stay visible) and still scrub through an animation. Play goes to the preview panel through the command event.
 */
export function MiniTransport({ playing }: { playing: boolean }) {
  const { t } = useI18n();
  const store = useStore();
  const project = useProjectStore((s) => s.project);
  const selection = useProjectStore((s) => s.selection);
  const rate = project?.sequences[0]?.frame_rate ?? { num: 30, den: 1 };
  const clip = selectedVideoClip(project, selection);
  const tol = ticksPerFrame(rate) / 2;
  // The nearest key of any animated property of the clip, before and after the playhead. Selectors answer a number, so the strip re-renders when the answer
  // changes (a key was passed), not on every playback tick; the time itself is written straight into its text node, like the preview's timecode.
  const props = [...new Set(Object.values(PROPS_OF).flat())];
  const near = (dir: -1 | 1, frame: number): number | undefined => {
    if (!clip) return undefined;
    const rel = relativeTicks(clip, frame, rate);
    const all = props.map((p) => neighbourKey(clip.transform?.[p], rel, tol, dir)).filter((x): x is number => x !== undefined);
    return all.length ? (dir < 0 ? Math.max(...all) : Math.min(...all)) : undefined;
  };
  const prev = useProjectStore((s) => near(-1, s.playhead));
  const next = useProjectStore((s) => near(1, s.playhead));
  const go = (to: number | undefined) => { if (clip && to !== undefined) store.setPlayhead(Math.max(0, ticksToFrame(clip.start + to, rate))); };
  const tc = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const show = () => { if (tc.current) tc.current.textContent = timecodeHMS(store.getState().playhead, rate); };
    show();
    return store.subscribe(show);
  }, [store, rate]);
  return (
    <div className="mini-transport" role="toolbar" aria-label={t("player.toolbar")} data-testid="mini-transport">
      <span className="mini-tc" aria-label={t("player.time")} ref={tc}>{timecodeHMS(store.getState().playhead, rate)}</span>
      <button className="icon-btn" aria-label={t("inspector.keyPrev")} disabled={prev === undefined} onClick={() => go(prev)}><Icon name="back" size={20} /></button>
      <button className="play" aria-label={playing ? t("player.pause") : t("player.play")} onClick={() => window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: { c: "play" } }))}><Icon name={playing ? "pause" : "play"} size={22} /></button>
      <button className="icon-btn" aria-label={t("inspector.keyNext")} disabled={next === undefined} onClick={() => go(next)}><Icon name="forward" size={20} /></button>
    </div>
  );
}
