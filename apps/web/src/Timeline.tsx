import { useMemo } from "react";
import type { Project } from "@app/engine-client";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { FPS } from "./timecode";
import { sampleProject } from "./timeline/fixture";
import { buildScene } from "./timeline/scene";
import { clampPps, ppsToSlider, sliderToPps } from "./timeline/view";
import { TimelineCanvas } from "./timeline/TimelineCanvas";

export const TIMELINE_SECONDS = 60;
export const END_FRAME = TIMELINE_SECONDS * FPS;


type Props = {
  frame: number;
  playing: boolean;
  zoom: number;
  onFrame: (f: number) => void;
  onZoom: (z: number) => void;
  onSoon: (what: string) => void;
  /** Project to draw; the sample project stands in until media is imported. */
  project?: Project;
  /** Frames per second and length of the previewed sequence (defaults: the sample timeline). */
  fps?: number;
  endFrame?: number;
};

export function Timeline({ frame, playing, zoom, onFrame, onZoom, onSoon, project, fps = FPS, endFrame = END_FRAME }: Props) {
  const { t } = useI18n();
  const source = useMemo(() => project ?? sampleProject(), [project]);
  const scene = useMemo(() => buildScene(source), [source]);
  const summary = t("timeline.summary", { name: source.name, tracks: scene.trackCount, clips: scene.clipCount, seconds: Math.round(scene.endSec), sample: project ? "no" : "yes" });
  return (
    <section className="timeline" aria-label={t("timeline.label")} data-testid="panel-timeline">
      <div className="tl-bar">
        <div className="tl-group" role="toolbar" aria-label={t("timeline.edit")}>
          <button className="icon-btn" aria-label={t("timeline.undo")} title={t("timeline.undo")} onClick={() => onSoon(t("timeline.undoSoon"))}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label={t("timeline.redo")} title={t("timeline.redo")} onClick={() => onSoon(t("timeline.redoSoon"))}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label={t("timeline.split")} title={t("timeline.split")} onClick={() => onSoon(t("timeline.splitSoon"))}><Icon name="split" /></button>
          <button className="icon-btn" aria-label={t("timeline.delete")} title={t("timeline.delete")} onClick={() => onSoon(t("timeline.deleteSoon"))}><Icon name="trash" /></button>
        </div>
        <label className="zoom">
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomOut")} onClick={() => onZoom(clampPps(zoom / 1.25))}><Icon name="minus" size={18} /></button>
          <input type="range" min={0} max={1} step={0.005} value={ppsToSlider(zoom)} onChange={(e) => onZoom(sliderToPps(Number(e.target.value)))} aria-label={t("timeline.zoom")} />
          <button type="button" className="icon-btn" aria-label={t("timeline.zoomIn")} onClick={() => onZoom(clampPps(zoom * 1.25))}><Icon name="plus" size={18} /></button>
        </label>
      </div>
      <div className="tl-stage">
        <TimelineCanvas scene={scene} fps={fps} frame={frame} endFrame={endFrame} playing={playing} zoom={zoom} onFrame={onFrame} onZoom={onZoom} summary={summary} />
      </div>
    </section>
  );
}
