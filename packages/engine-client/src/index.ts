import type { Engine, MediaApi } from "./types";

export * from "./types";
export { NETWORK_CHANNEL, reportWorkerNetwork, type NetReport } from "./net-report";
export * from "./export/types";
export { H264Error, PathFile, baseName, h264Percent, mimeOfPath, parseH264Failure, type DesktopApi, type DesktopCodecs, type H264FailureCode, type H264Progress } from "./desktop";
export { createExportApi, exportNotYet, type ExportHost, type WorkerLike } from "./export/job";
import type { WorkerLike } from "./export/job";
import type { GpuRenderer } from "./render";
import type { Evaluator } from "./wasm";
import type { Stretcher } from "./audio-stretch";
export { probeExportFormats, type ExportFormatId, type ExportFormatOption, type ExportFormats } from "./export/options";
export { defaultVideoBitrate } from "./export/presets";
export { cleanupStaleExports, opfsStorage, type ExportStorage } from "./export/storage";
export { registerMediaResolver, type MediaResolver, type OpenedMedia, type MediaVideo, type MediaAudio, type DrawableFrame } from "./export/media";
export { containScale, fitScale, layerOf, placeLayer, renderExportFrame, type GpuLayer, type GpuRenderer, type LayerSource, type RendererInfo } from "./render";
export type { Evaluator };
export { addMarkerOp, addTrackOp, createEditing, deleteMarkerOp, moveMarkerOp, moveTrackOp, newMarker, newTrack, parseEditOutcome, removeTrackOp, setMarkerPropsOp, setRangeOp, setTrackPropsOp, type RawEditing } from "./editing";
export { probeHost } from "./probe";
export { applyEditPatch, type ClipSplice, type EditPatch, type SequencePatch, type TrackPatch } from "./patch";

/** True inside a Tauri shell (desktop or mobile app), false in a plain browser. */
export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** One entry point for every platform: the native engine in an app shell, the WebAssembly engine everywhere else. */
export async function createEngine(): Promise<Engine> {
  if (isTauri()) return (await import("./tauri")).createTauriEngine();
  // A fresh module Worker per export job: it loads its own copy of the engine, opens the project snapshot and streams the file to OPFS.
  const spawnExportWorker = (): WorkerLike => new Worker(new URL("./export/worker-entry.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  return (await import("./wasm")).createWasmEngine({ spawnExportWorker });
}

/** The GPU compositor for a canvas (a Worker's `OffscreenCanvas`): the same Rust compositor serves preview and export. Browser only. */
export async function openRenderer(canvas: OffscreenCanvas, prefer: "auto" | "webgpu" | "webgl2" = "auto"): Promise<GpuRenderer> {
  return (await import("./wasm")).openWasmRenderer(canvas, prefer);
}

/** The production decoder without a project (the preview Worker opens its own handles from the bin's files). Browser only. */
export async function openMediaApi(): Promise<MediaApi> {
  return (await import("./wasm")).openWasmMedia();
}

/** A project snapshot's `evaluate` plus a media decoder, for a Worker (the preview player runs there). Browser only. */
export async function openEvaluator(projectJson: string): Promise<Evaluator> {
  return (await import("./wasm")).openWasmEvaluator(projectJson);
}
/** The pitch-keeping audio stretcher for clip speed (`docs/features/speed.md`). Browser and desktop webview (same wasm module). */
export async function openStretcher(): Promise<Stretcher> {
  return (await import("./wasm")).openWasmStretcher();
}
export { ClipStretchCache, MAX_STRETCH_SECONDS, type ReadPlanar, type Stretcher } from "./audio-stretch";
export * from "./model.generated";
export { codecName } from "./decode/errors";
export { FINGERPRINT_WINDOW, fingerprintFile, fingerprintSize, relinkMedia, type Candidate, type RelinkResult, type Sliceable } from "./media";
export { StorageError, toStorageError, type ProjectStorage, type StorageErrorCode } from "./persist/storage";
export { MAX_AUTO, SnapshotStore, retain, type SnapshotInfo, type SnapshotKind } from "./persist/snapshots";
export { memoryStorage } from "./persist/memory";
export { openProjectSession, ProjectSession, type OpenedSession, type RecoveryNote, type SaveStatus, type SessionOptions } from "./persist/session";
export { acquireProjectLock, openProjectStorage } from "./persist/open";
export { LEGACY_PROJECT_ID, ProjectRegistry, REGISTRY_ID, copyName, countClips, deleteProjectData, migrateSingleProject, newProjectId, summarize, summarizeExtra, type ProjectEntry, type RegistryData } from "./persist/registry";
export { PROJECT_FILE } from "./persist/session";
export { newId, newProject, PROJECT_SCHEMA_VERSION } from "./project";
