import { createEditing } from "./editing";
import { createExportApi, type WorkerLike } from "./export/job";
import { opfsStorage } from "./export/storage";
import { createWebMedia, type WasmMediaClass } from "./decode/media";
import type { GpuRenderer as GpuRendererClass } from "@app/wasm-pkg";
import { wrapRenderer, type GpuRenderer } from "./render";
import { parseEngineInfo, parseOpenedProject, toProjectFileError, type Engine, type FrameDescription, type MediaApi } from "./types";

/** Browser backend: loads the WebAssembly build once. Run the engine inside a Web Worker when it starts doing real work (see docs). */
export async function createWasmEngine(opts: { spawnExportWorker: () => WorkerLike }): Promise<Engine> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  let editor: InstanceType<typeof wasm.Editor> | undefined;
  const open = () => {
    if (!editor) throw new Error("no project is open");
    return editor;
  };
  const editing = createEditing({
    open: (projectJson) => {
      const next = new wasm.Editor(projectJson); // throws on an invalid project, keeping the old one
      editor?.free();
      editor = next;
    },
    apply: (opsJson, coalesce) => open().apply(opsJson, coalesce),
    undo: () => open().undo(),
    redo: () => open().redo(),
    project: () => open().project(),
    journal: () => open().journal(),
    evaluate: (sequence, ticks, audioSamples) => open().evaluate(sequence, ticks, audioSamples),
    takeLog: () => open().take_log(),
    checkpoint: () => open().checkpoint(),
    recover: (baseJson, checkpointJson, log) => {
      const next = wasm.Editor.recover(baseJson ?? undefined, checkpointJson ?? undefined, log); // throws, keeping the old editor
      editor?.free();
      editor = next;
      return next.recovery() ?? "{}";
    },
  });
  return {
    backend: "wasm",
    media: createWebMedia(wasm.MediaFile as unknown as WasmMediaClass),
    info: async () => parseEngineInfo(wasm.engine_info()),
    openProject: async (bytes) => {
      try {
        return parseOpenedProject(wasm.project_open(bytes));
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    saveProject: async (project, previous) => {
      try {
        return wasm.project_save(JSON.stringify(project), previous ?? new Uint8Array());
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    fingerprintMedia: async (size, first, last) => {
      try {
        return wasm.media_fingerprint(size, first, last);
      } catch (e) {
        throw toProjectFileError(e);
      }
    },
    peaks: {
      begin: async (sampleRate, channels, resume) => {
        const job = new wasm.PeaksJob(sampleRate, channels, resume ?? new Uint8Array());
        const nextFrame = job.next_frame();
        let live = true;
        return {
          nextFrame,
          push: async (pcm) => job.push(pcm),
          snapshot: async () => job.snapshot(),
          finish: async () => {
            const out = job.finish();
            live = false;
            job.free();
            return out;
          },
          dispose: async () => {
            if (live) job.free();
            live = false;
          },
        };
      },
      open: async (file) => {
        const view = new wasm.PeaksView(file);
        const sampleRate = view.sample_rate(), frames = view.frames(), complete = view.complete();
        return { sampleRate, frames, complete, columns: async (a, b, n) => view.columns(a, b, n), close: async () => view.free() };
      },
    },
    editing,
    export: createExportApi({
      spawn: opts.spawnExportWorker,
      project: () => editing.project(),
      storage: opfsStorage,
    }),
  };
}

/**
 * For the export Worker (`export/worker-entry.ts`): loads the engine inside the worker and opens the project snapshot. Lives here because this file is the
 * only one allowed to import the wasm package (`npm run check:boundaries`). Must not reference the worker URL (that would make the worker bundle itself).
 */
export interface Evaluator {
  evaluate(sequence: string, ticks: number, samples: number): FrameDescription;
  media: MediaApi;
  free(): void;
}

export async function openWasmEvaluator(projectJson: string): Promise<Evaluator> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  const editor = new wasm.Editor(projectJson);
  return {
    evaluate: (sequence, ticks, samples) => JSON.parse(editor.evaluate(sequence, BigInt(ticks), samples)) as FrameDescription,
    media: createWebMedia(wasm.MediaFile as unknown as WasmMediaClass),
    free: () => editor.free(),
  };
}

/**
 * WebGPU is only trusted after it has done the two things the app depends on on a scratch canvas: import a WebCodecs `VideoFrame` into a layer and
 * read the composited frame back (browsers differ here, and a preview that silently shows black is worse than WebGL2). Costs a few ms once.
 */
async function webgpuWorks(wasm: { GpuRenderer: typeof GpuRendererClass }): Promise<boolean> {
  if (typeof VideoFrame === "undefined") return false;
  let r: GpuRenderer | undefined;
  let frame: VideoFrame | undefined;
  try {
    const probe = new OffscreenCanvas(8, 8);
    r = wrapRenderer(await wasm.GpuRenderer.create(probe, "webgpu"), probe);
    r.resize(8, 8);
    const src = new OffscreenCanvas(2, 2);
    const g = src.getContext("2d");
    if (!g) return false;
    g.fillStyle = "#ff0000";
    g.fillRect(0, 0, 2, 2);
    frame = new VideoFrame(src, { timestamp: 0 });
    const px = await r.readback([{ source: frame, width: 2, height: 2, rotation: 0, center: [4, 4], scale: [4, 4], angle: 0, opacity: 1 }], { width: 8, height: 8 }, { width: 8, height: 8 });
    const i = (4 * 8 + 4) * 4;
    return px[i]! > 200 && px[i + 1]! < 40 && px[i + 2]! < 40;
  } catch {
    return false;
  } finally {
    frame?.close();
    r?.dispose();
  }
}

/**
 * The GPU compositor on `canvas` (an `OffscreenCanvas` in a Worker): `prefer` "auto" (WebGPU when its self-test passes, else WebGL2), "webgpu" or
 * "webgl2" (both forced, no test). Rejects with a plain message when no GPU backend can be set up.
 */
export async function openWasmRenderer(canvas: OffscreenCanvas, prefer: "auto" | "webgpu" | "webgl2" = "auto"): Promise<GpuRenderer> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  const backend = prefer === "auto" ? ((await webgpuWorks(wasm)) ? "webgpu" : "webgl2") : prefer;
  return wrapRenderer(await wasm.GpuRenderer.create(canvas, backend), canvas);
}

/** The production decoder (`Engine.media`) on its own, for a Worker that decodes but does not own a project. */
export async function openWasmMedia(): Promise<MediaApi> {
  const wasm = await import("@app/wasm-pkg");
  await wasm.default();
  return createWebMedia(wasm.MediaFile as unknown as WasmMediaClass);
}
