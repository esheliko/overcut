import { useMemo } from "react";
import type { Project } from "@app/engine-client";
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
};

export function Timeline({ frame, playing, zoom, onFrame, onZoom, onSoon, project }: Props) {
  const source = useMemo(() => project ?? sampleProject(), [project]);
  const scene = useMemo(() => buildScene(source), [source]);
  const summary = `Timeline of ${source.name}: ${scene.trackCount} tracks, ${scene.clipCount} clips, ${Math.round(scene.endSec)} seconds of media. ${project ? "" : "Sample clips shown until you add media."}`;
  return (
    <section className="timeline" aria-label="Timeline" data-testid="panel-timeline">
      <div className="tl-bar">
        <div className="tl-group" role="toolbar" aria-label="Edit">
          <button className="icon-btn" aria-label="Undo" title="Undo" onClick={() => onSoon("Undo arrives with editing in M1")}><Icon name="undo" /></button>
          <button className="icon-btn" aria-label="Redo" title="Redo" onClick={() => onSoon("Redo arrives with editing in M1")}><Icon name="redo" /></button>
          <span className="sep" aria-hidden="true" />
          <button className="icon-btn" aria-label="Split at playhead" title="Split at playhead" onClick={() => onSoon("Split arrives with editing in M1")}><Icon name="split" /></button>
          <button className="icon-btn" aria-label="Delete" title="Delete" onClick={() => onSoon("Delete arrives with editing in M1")}><Icon name="trash" /></button>
        </div>
        <label className="zoom">
          <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => onZoom(clampPps(zoom / 1.25))}><Icon name="minus" size={18} /></button>
          <input type="range" min={0} max={1} step={0.005} value={ppsToSlider(zoom)} onChange={(e) => onZoom(sliderToPps(Number(e.target.value)))} aria-label="Timeline zoom" />
          <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => onZoom(clampPps(zoom * 1.25))}><Icon name="plus" size={18} /></button>
        </label>
      </div>
      <div className="tl-stage">
        <TimelineCanvas scene={scene} fps={FPS} frame={frame} endFrame={END_FRAME} playing={playing} zoom={zoom} onFrame={onFrame} onZoom={onZoom} summary={summary} />
      </div>
    </section>
  );
}
