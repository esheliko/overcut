/**
 * Desktop preview of files that stay on disk (issue #58). A `PathFile` cannot be cloned into the preview Worker (it would arrive as an empty `File`),
 * and Tauri's `invoke` does not exist inside a Worker. So the UI thread owns the native decoders (`Engine.media`, libav) and the Worker holds a
 * `RemoteHandle` that asks for frames and audio over the existing request / reply channel. Same `MediaHandle` contract, so the player does not know.
 */
import { MediaDecodeError, type DecodedFrame, type FrameStream, type MediaApi, type MediaFileInfo, type MediaHandle, type MediaErrorKind } from "@app/engine-client";

/** One question from the Worker to the UI thread. */
export type NativeOp =
  | { op: "open"; path: string }
  | { op: "frame"; handle: number; index: number }
  | { op: "audio"; handle: number; start: number; count: number }
  | { op: "close"; handle: number };

export interface NativeOpen {
  handle: number;
  info: MediaFileInfo;
  audioRate: number;
  /** Presentation timestamp (ticks) of every video frame, so `frameIndexAt` stays synchronous in the Worker. */
  pts: number[];
}
export interface NativeFrame { width: number; height: number; rgba: Uint8Array }
export type NativeFailure = { error: { kind: MediaErrorKind; message: string } };
export type NativeReply = NativeOpen | NativeFrame | Float32Array | null | NativeFailure;

/** What the native handle exposes beyond `MediaHandle`: the timestamps of its frames. */
type WithPts = MediaHandle & { presentationTicks?: () => readonly number[] };

/** Last frame whose timestamp is not after `ticks` (same rule as `frameIndexAtTicks` in the engine client). */
export function frameIndexIn(pts: readonly number[], ticks: number): number {
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((pts[mid] ?? 0) <= ticks) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

const failure = (e: unknown): NativeFailure => ({ error: e instanceof MediaDecodeError ? { kind: e.kind, message: e.message } : { kind: "io", message: e instanceof Error ? e.message : String(e) } });

/** UI-thread side: owns the native handles the Worker asked for and answers its questions. */
export class NativeMediaBridge {
  private readonly handles = new Map<number, WithPts>();
  private next = 1;

  constructor(private readonly media: MediaApi) {}

  /** The answer and the buffers to transfer (not copy) with it. Never throws: a failure is a value the Worker turns back into an error. */
  async answer(q: NativeOp): Promise<{ value: NativeReply; transfer: Transferable[] }> {
    try {
      switch (q.op) {
        case "open": {
          // The native media API takes a `Blob` that also knows its path and decodes it in place.
          const h = (await this.media.open(Object.assign(new Blob([]), { path: q.path }), { audioRate: 48_000 })) as WithPts;
          const pts = h.presentationTicks?.() ?? [];
          const handle = this.next++;
          this.handles.set(handle, h);
          return { value: { handle, info: h.info, audioRate: h.audioRate, pts: [...pts] }, transfer: [] };
        }
        case "frame": {
          const f = await this.of(q.handle).videoFrame(q.index);
          try {
            if (f.kind !== "cpu") throw new MediaDecodeError("unsupported", "the native decoder returned a GPU frame");
            // The frame's pixels are a view into the IPC buffer: copy only when the view does not own its whole buffer.
            const rgba = f.rgba.byteOffset === 0 && f.rgba.byteLength === f.rgba.buffer.byteLength ? f.rgba : f.rgba.slice();
            return { value: { width: f.width, height: f.height, rgba }, transfer: [rgba.buffer] };
          } finally {
            f.release();
          }
        }
        case "audio": {
          const pcm = await this.of(q.handle).audio(q.start, q.count);
          return { value: pcm, transfer: [pcm.buffer] };
        }
        case "close": {
          const h = this.handles.get(q.handle);
          this.handles.delete(q.handle);
          await h?.close();
          return { value: null, transfer: [] };
        }
      }
    } catch (e) {
      return { value: failure(e), transfer: [] };
    }
  }

  private of(id: number): MediaHandle {
    const h = this.handles.get(id);
    if (!h) throw new MediaDecodeError("invalid", "media is closed");
    return h;
  }

  /** The Worker went away: close everything it had open. */
  async dispose(): Promise<void> {
    const all = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(all.map((h) => h.close().catch(() => undefined)));
  }
}

/** Worker side: asks the UI thread. `call` posts the question and resolves with the reply. */
export type NativeCall = (q: NativeOp) => Promise<NativeReply>;

const isFailure = (r: NativeReply): r is NativeFailure => r !== null && typeof r === "object" && "error" in r;

async function ask<T extends NativeReply>(call: NativeCall, q: NativeOp): Promise<T> {
  const r = await call(q);
  if (isFailure(r)) throw new MediaDecodeError(r.error.kind, r.error.message);
  return r as T;
}

/** A `MediaApi` whose files live behind the UI thread's native decoder. `open` takes the path (not a `Blob`). */
export function createRemoteMedia(call: NativeCall): { openPath(path: string): Promise<MediaHandle> } {
  return {
    async openPath(path) {
      const r = await ask<NativeOpen>(call, { op: "open", path });
      return new RemoteHandle(call, r);
    },
  };
}

class RemoteHandle implements MediaHandle {
  readonly frameKind = "cpu" as const;
  readonly info: MediaFileInfo;
  readonly audioRate: number;
  private closed = false;
  private readonly counts = { received: 0, closed: 0 };

  constructor(private readonly call: NativeCall, private readonly r: NativeOpen) {
    this.info = r.info;
    this.audioRate = r.audioRate;
  }

  frameIndexAt(ticks: number): number {
    return frameIndexIn(this.r.pts, ticks);
  }

  async videoFrame(index: number): Promise<DecodedFrame> {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    if (!this.info.video) throw new MediaDecodeError("out_of_range", "this file has no video");
    if (!Number.isInteger(index) || index < 0 || index >= this.r.pts.length) throw new MediaDecodeError("out_of_range", `frame ${index} is outside the clip`);
    const f = await ask<NativeFrame>(this.call, { op: "frame", handle: this.r.handle, index });
    this.counts.received++;
    let released = false;
    return {
      kind: "cpu", index, ptsTicks: this.r.pts[index] ?? 0, width: f.width, height: f.height, rgba: f.rgba,
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
      next: async () => (done || next >= this.r.pts.length ? null : this.videoFrame(next++)),
      buffered: () => 0,
      close: () => { done = true; },
    };
  }

  async audio(startSample: number, count: number): Promise<Float32Array> {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    if (!this.info.audio) throw new MediaDecodeError("out_of_range", "this file has no audio");
    return ask<Float32Array>(this.call, { op: "audio", handle: this.r.handle, start: startSample, count });
  }

  stats(): { received: number; closed: number; open: number } {
    return { ...this.counts, open: this.counts.received - this.counts.closed };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.call({ op: "close", handle: this.r.handle }).catch(() => undefined);
  }
}
