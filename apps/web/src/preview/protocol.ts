/**
 * Messages between the UI thread and the preview Worker (M1-023). The Worker owns the compositor (on the transferred canvas), the player loop,
 * decoding and audio mixing; the UI thread keeps the AudioContext (Web Audio does not exist in workers), which stays the master clock.
 */
import type { RendererInfo } from "@app/engine-client";
import type { Rate } from "./timing";

export type PreviewCommand =
  | { name: "seek"; frame: number }
  | { name: "step"; delta: number }
  | { name: "toggle" }
  | { name: "key"; key: "J" | "K" | "L" }
  | { name: "play"; rate: number }
  | { name: "pause" };

/** Test and measurement requests (answered with a `reply`). */
export type PreviewRpc =
  | { name: "stats" }
  | { name: "probe"; x: number; y: number }
  | { name: "frames" }
  | { name: "position" }
  | { name: "gpu" }
  | { name: "bench"; width: number; height: number; frames: number }
  | { name: "parity"; frame: number };

/** What the Worker plays: the shared project's JSON (empty = the idle, black timeline) and the sequence settings. */
export interface PreviewConfig {
  project: string;
  sequence: string;
  rate: Rate;
  size: { width: number; height: number };
  endTicks: number;
}

export type ToPreview =
  | { type: "init"; canvas: OffscreenCanvas; prefer: "auto" | "webgpu" | "webgl2" }
  /** First message: the player is created. Later ones: the project changed (edit, undo, import): the evaluator is replaced and the same player reconfigured. */
  | ({ type: "config" } & PreviewConfig)
  /** The file behind a media item (cloned, not copied): the Worker opens its own decoder. */
  | { type: "media"; id: string; file: File }
  | { type: "unmedia"; id: string }
  | { type: "resize"; width: number; height: number }
  | { type: "cmd"; cmd: PreviewCommand }
  /** The audible audio clock sampled on the UI thread: `audio` (seconds) at `epoch` (ms, `performance.timeOrigin + performance.now()`). */
  | { type: "clock"; audio: number; epoch: number }
  | { type: "rpc"; id: number; rpc: PreviewRpc }
  | { type: "reply"; id: number; value: unknown }
  | { type: "dispose" };

export type FromPreview =
  | { type: "ready"; info: RendererInfo }
  | { type: "fail"; message: string }
  | { type: "frame"; frame: number }
  | { type: "state"; playing: boolean; rate: number }
  | { type: "error"; message: string }
  | { type: "audio"; left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer>; when: number }
  | { type: "audio-stop" }
  /** The worker asks the UI thread to start the audio output; answered with a `reply` `{ running, audio, epoch }`. */
  | { type: "request"; id: number; name: "audio-resume" }
  | { type: "reply"; id: number; value: unknown };

/** Wall clock shared by every thread of the page (ms). */
export const epochNow = (): number => performance.timeOrigin + performance.now();
