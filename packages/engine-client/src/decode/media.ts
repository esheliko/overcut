import { blobSource, type ByteSource } from "./blob-source";
import { MediaDecodeError, toMediaError } from "./errors";
import { WebCodecsHost, type HostStats } from "./host";
import { openStill } from "./still";
import { buildFrameTable, frameIndexAt, type FrameTable } from "./frames";
import { openFrameStream, type StreamTrack } from "./stream";
import type { PacketJson } from "./blob-source";
import type { DecodedFrame, FrameStream, MediaApi, MediaFileInfo, MediaHandle, OpenMediaOptions, TrackInfo } from "../types";

/** The slice of the wasm `MediaFile` class this layer uses (see crates/wasm/src/media.rs; types in wasm-module.d.ts). */
export interface WasmMediaFile {
  info(): string;
  videoPacketsJson(): string;
  videoDescription(): Uint8Array;
  audioDescription(): Uint8Array;
  attach(host: object, audioRate: number): void;
  setGpu(gpu: boolean): void;
  videoFrame(index: number): Promise<WasmFrameRef>;
  audio(startSample: number, count: number): Promise<Float32Array>;
  free(): void;
}
export interface WasmFrameRef {
  index(): number;
  ptsTicks(): number;
  width(): number;
  height(): number;
  gpuId(): number | undefined;
  pixels(): Uint8Array | undefined;
  free(): void;
}
export interface WasmMediaClass {
  open(source: { length: number; read(offset: number, len: number): Promise<Uint8Array> }): Promise<WasmMediaFile>;
}

function parseTrack(v: unknown): TrackInfo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const fps = Array.isArray(o.fps) ? { num: Number(o.fps[0]), den: Number(o.fps[1]) } : undefined;
  return {
    codec: String(o.codec),
    width: Number(o.width),
    height: Number(o.height),
    rotation: Number(o.rotation),
    sampleRate: Number(o.sampleRate),
    channels: Number(o.channels),
    durationTicks: Number(o.durationTicks),
    packets: Number(o.packets),
    fps,
    vfr: Boolean(o.vfr),
  };
}

/** The web implementation of `Engine.media`: wasm demux + planning, `WebCodecsHost` decode. Create it where the engine runs (a Worker). */
export function createWebMedia(Media: WasmMediaClass): MediaApi {
  return {
    async open(file: Blob, opts: OpenMediaOptions = {}): Promise<MediaHandle> {
      const audioRate = opts.audioRate ?? 48_000;
      const still = await openStill(file, opts); // a picture is a one-frame clip
      if (still) return still;
      const src = blobSource(file);
      let mf: WasmMediaFile;
      try {
        mf = await Media.open(src);
      } catch (e) {
        throw toMediaError(e);
      }
      let host: WebCodecsHost | undefined;
      try {
        const raw = JSON.parse(mf.info()) as { container: string; durationTicks: number; video: unknown; audio: unknown };
        const video = parseTrack(raw.video);
        const audio = parseTrack(raw.audio);
        const info: MediaFileInfo = { container: raw.container, durationTicks: raw.durationTicks, video, audio };
        host = await WebCodecsHost.create(
          src,
          {
            video: video && { codec: video.codec, width: video.width, height: video.height, description: mf.videoDescription() },
            audio: audio && { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.channels, description: mf.audioDescription() },
          },
          { preferGpu: opts.gpu ?? true },
        );
        mf.attach(host, audioRate);
        const frameKind = video && host.hasGpu() && opts.gpu !== false ? "gpu" : "cpu";
        if (video) mf.setGpu(frameKind === "gpu");
        const table = video ? buildFrameTable(JSON.parse(mf.videoPacketsJson()) as PacketJson[]) : undefined;
        const streamTrack = video && { codec: video.codec, width: video.width, height: video.height, description: mf.videoDescription() };
        return new Handle(mf, host, info, frameKind, audioRate, src, table, streamTrack);
      } catch (e) {
        host?.dispose();
        mf.free();
        throw toMediaError(e);
      }
    },
  };
}

class Handle implements MediaHandle {
  private tail: Promise<unknown> = Promise.resolve();
  private ticket = 0;
  private closed = false;

  constructor(
    private readonly mf: WasmMediaFile,
    private readonly host: WebCodecsHost,
    readonly info: MediaFileInfo,
    readonly frameKind: "gpu" | "cpu",
    readonly audioRate: number,
    private readonly src: ByteSource,
    private readonly table: FrameTable | undefined,
    private readonly streamTrack: StreamTrack | undefined,
  ) {}

  private readonly streams = new Set<FrameStream>();
  private readonly streamStats = { received: 0, closed: 0 };

  frameIndexAt(ticks: number): number {
    return this.table ? frameIndexAt(this.table, ticks) : 0;
  }

  gop(): { frames: number; maxGop: number; meanGop: number } {
    const frames = this.table?.pts.length ?? 0;
    const keys = this.table?.keys ?? new Int32Array(0);
    if (frames === 0) return { frames: 0, maxGop: 0, meanGop: 0 };
    if (keys.length === 0) return { frames, maxGop: frames, meanGop: frames };
    let max = 0;
    for (let i = 0; i < keys.length; i++) max = Math.max(max, (i + 1 < keys.length ? keys[i + 1]! : frames) - keys[i]!);
    return { frames, maxGop: max, meanGop: frames / keys.length };
  }

  stream(startIndex: number, maxBuffered = 8): FrameStream {
    if (this.closed) throw new MediaDecodeError("invalid", "media is closed");
    if (!this.table || !this.streamTrack) throw new MediaDecodeError("invalid", "no video track");
    const s = openFrameStream(this.src, this.streamTrack, this.table, startIndex, Math.max(1, maxBuffered), this.streamStats);
    this.streams.add(s);
    const close = s.close.bind(s);
    s.close = () => { this.streams.delete(s); close(); };
    return s;
  }

  /** The wasm object is borrowed for the whole of an async call, so calls run strictly one after another. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  videoFrame(index: number): Promise<DecodedFrame> {
    if (this.closed) return Promise.reject(new MediaDecodeError("invalid", "media is closed"));
    const mine = ++this.ticket;
    this.host.cancel(); // a running older seek fails with `cancelled` right away
    return this.serial(async () => {
      if (mine !== this.ticket) throw new MediaDecodeError("cancelled", "cancelled"); // superseded while queued
      let ref: WasmFrameRef;
      try {
        ref = await this.mf.videoFrame(index);
      } catch (e) {
        throw toMediaError(e);
      }
      const base = { index: ref.index(), ptsTicks: ref.ptsTicks(), width: ref.width(), height: ref.height() };
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          ref.free();
        }
      };
      const id = ref.gpuId();
      if (id !== undefined) {
        const frame = this.host.frame(id);
        if (!frame) {
          release();
          throw new MediaDecodeError("io", "decoded frame vanished");
        }
        return { ...base, kind: "gpu", frame, release } as DecodedFrame;
      }
      const rgba = ref.pixels();
      release();
      if (!rgba) throw new MediaDecodeError("io", "decoder returned no pixels");
      return { ...base, kind: "cpu", rgba, release: () => undefined } as DecodedFrame;
    });
  }

  audio(startSample: number, count: number): Promise<Float32Array> {
    if (this.closed) return Promise.reject(new MediaDecodeError("invalid", "media is closed"));
    return this.serial(async () => {
      try {
        return await this.mf.audio(startSample, count);
      } catch (e) {
        throw toMediaError(e);
      }
    });
  }

  stats(): HostStats {
    const h = this.host.stats();
    const received = h.received + this.streamStats.received;
    const closed = h.closed + this.streamStats.closed;
    return { received, closed, open: received - closed };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const s of [...this.streams]) s.close();
    this.host.cancel();
    await this.tail;
    this.host.dispose();
    this.mf.free();
  }
}
