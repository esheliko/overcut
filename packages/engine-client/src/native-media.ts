import { MediaDecodeError, toMediaError } from "./decode/errors";
import type { NativeExportBackend } from "./export/native";
import type { DecodedFrame, FrameStream, MediaFileInfo, MediaHandle, MediaApi, OpenMediaOptions, TrackInfo } from "./types";

/** A file the webview picked that also knows where it lives (a Tauri dialog / drag-drop result): decoded in place, never copied. */
export type PathBlob = Blob & { path?: string };

/** What Tauri rejects with when the shell was built without the `native-media` feature (the command is not registered). */
export const isMissingCommand = (e: unknown): boolean => /not found|not allowed|unknown command/i.test(e instanceof Error ? e.message : String(e));

/** Tauri's `invoke` (passed in by `tauri.ts`, the only file allowed to import `@tauri-apps/*`). A `Uint8Array` argument is sent as a raw binary body. */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) => Promise<T>;

const STASH_CHUNK = 8 * 1024 * 1024;

/** Stages a path-less `Blob` (browser file picker) in a temp file, chunk by chunk, so libav can seek in it. Cached per blob; removed with the handle. */
async function stash(invoke: Invoke, blob: Blob): Promise<{ path: string; id: number }> {
  const { id, path } = JSON.parse(await invoke<string>("native_stash_begin")) as { id: number; path: string };
  try {
    for (let off = 0; off < blob.size; off += STASH_CHUNK) {
      const bytes = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + STASH_CHUNK)).arrayBuffer());
      await invoke("native_stash_append", bytes, { headers: { "x-id": String(id) } });
    }
    await invoke("native_stash_end", { id });
  } catch (e) {
    await invoke("native_stash_remove", { id }).catch(() => undefined);
    throw e;
  }
  return { path, id };
}

function parseTrack(v: unknown): TrackInfo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const fps = Array.isArray(o.fps) ? { num: Number(o.fps[0]), den: Number(o.fps[1]) } : undefined;
  return {
    codec: String(o.codec), width: Number(o.width), height: Number(o.height), rotation: Number(o.rotation), sampleRate: Number(o.sampleRate),
    channels: Number(o.channels), durationTicks: Number(o.durationTicks), packets: Number(o.packets), fps, vfr: Boolean(o.vfr),
  };
}

/** Last frame whose timestamp is not after `ticks` (`pts` is sorted, ticks): the web decoder's `frameIndexAt`. */
export function frameIndexAtTicks(pts: readonly number[], ticks: number): number {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((pts[mid] ?? 0) <= ticks) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/**
 * `Engine.media` over libav (`native_media_*` commands). Same contract as the web decoder: frame-accurate `videoFrame`, interleaved f32 `audio`
 * at the project rate, typed `MediaDecodeError`s. Frames are CPU RGBA (`kind: "cpu"`): GPU-resident native frames need the renderer to import
 * them (follow-up, ADR 0004 S4 results). `stream` decodes frame by frame (each call seeks to its keyframe): correct, not yet fast.
 */
export function createTauriMedia(invoke: Invoke): MediaApi {
  return {
    async open(file: Blob, opts: OpenMediaOptions = {}): Promise<MediaHandle> {
      const audioRate = opts.audioRate ?? 48_000;
      let staged: number | undefined;
      let path = (file as PathBlob).path;
      try {
        if (!path) {
          const s = await stash(invoke, file);
          path = s.path;
          staged = s.id;
        }
        const r = JSON.parse(await invoke<string>("native_media_open", { path, audioRate })) as { id: number; info: { container: string; durationTicks: number; video: unknown; audio: unknown }; pts: number[] };
        const info: MediaFileInfo = { container: r.info.container, durationTicks: r.info.durationTicks, video: parseTrack(r.info.video), audio: parseTrack(r.info.audio) };
        return new NativeHandle(invoke, r.id, info, audioRate, r.pts, staged);
      } catch (e) {
        if (staged !== undefined) await invoke("native_stash_remove", { id: staged }).catch(() => undefined);
        if (isMissingCommand(e)) throw new MediaDecodeError("unsupported", "This build of the desktop app has no native media decoder. Use the web app, or a build with the native-media feature.");
        throw toMediaError(e);
      }
    },
  };
}

class NativeHandle implements MediaHandle {
  readonly frameKind = "cpu" as const;
  private closed = false;
  private readonly counts = { received: 0, closed: 0 };

  constructor(private readonly invoke: Invoke, private readonly id: number, readonly info: MediaFileInfo, readonly audioRate: number, private readonly pts: readonly number[], private readonly staged: number | undefined) {}

  frameIndexAt(ticks: number): number {
    return frameIndexAtTicks(this.pts, ticks);
  }

  /** Timestamp (ticks) of every video frame in presentation order: the desktop preview Worker gets a copy so its `frameIndexAt` stays synchronous. */
  presentationTicks(): readonly number[] {
    return this.pts;
  }

  async videoFrame(index: number): Promise<DecodedFrame> {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    if (!this.info.video) throw new MediaDecodeError("out_of_range", "this file has no video");
    if (!Number.isInteger(index) || index < 0 || index >= this.pts.length) throw new MediaDecodeError("out_of_range", `frame ${index} is outside the clip`);
    let buf: ArrayBuffer;
    try {
      buf = await this.invoke<ArrayBuffer>("native_media_frame", { id: this.id, index });
    } catch (e) {
      throw toMediaError(e);
    }
    const head = new DataView(buf, 0, 8);
    const width = head.getUint32(0, true);
    const height = head.getUint32(4, true);
    this.counts.received++;
    let released = false;
    return {
      kind: "cpu", index, ptsTicks: this.pts[index] ?? 0, width, height, rgba: new Uint8Array(buf, 8),
      release: () => {
        if (!released) {
          released = true;
          this.counts.closed++;
        }
      },
    };
  }

  stream(startIndex: number): FrameStream {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    let next = Math.max(0, startIndex);
    let done = false;
    return {
      next: async () => {
        if (done || next >= this.pts.length) return null;
        return this.videoFrame(next++);
      },
      buffered: () => 0,
      close: () => {
        done = true;
      },
    };
  }

  async audio(startSample: number, count: number): Promise<Float32Array> {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    if (!this.info.audio) throw new MediaDecodeError("out_of_range", "this file has no audio");
    try {
      return new Float32Array(await this.invoke<ArrayBuffer>("native_media_audio", { id: this.id, start: startSample, count }));
    } catch (e) {
      throw toMediaError(e);
    }
  }

  stats(): { received: number; closed: number; open: number } {
    return { ...this.counts, open: this.counts.received - this.counts.closed };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.invoke("native_media_close", { id: this.id }).catch(() => undefined);
    if (this.staged !== undefined) await this.invoke("native_stash_remove", { id: this.staged }).catch(() => undefined);
  }
}

/** The `native_export_*` commands as the loop's encoder backend. Errors come back as the engine's message strings. */
export function createTauriExportBackend(invoke: Invoke): NativeExportBackend {
  return {
    begin: async (args) => JSON.parse(await invoke<string>("native_export_begin", { args })) as { id: number; path: string; encoder: string },
    video: (id, rgba) => invoke<void>("native_export_video", rgba, { headers: { "x-id": String(id) } }),
    audio: (id, pcm) => invoke<void>("native_export_audio", new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), { headers: { "x-id": String(id) } }),
    finish: async (id) => JSON.parse(await invoke<string>("native_export_finish", { id })) as Awaited<ReturnType<NativeExportBackend["finish"]>>,
    cancel: (id) => invoke<void>("native_export_cancel", { id }),
    read: async (fileName, offset, len) => new Uint8Array(await invoke<ArrayBuffer>("native_export_read", { fileName, offset, len })),
    remove: (fileName) => invoke<void>("native_export_remove", { fileName }),
  };
}
