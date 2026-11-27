import { codecName, MediaDecodeError } from "./errors";
import { readPackets, type ByteSource } from "./blob-source";
import { startPacket, usToTicks, type FrameTable } from "./frames";
import type { ColourInfo, DecodedFrame, FrameStream } from "../types";
import { colourSpaceInit } from "./colour";

/** Packets read from the file per range read while streaming. */
const READ_BATCH = 24;
/** Never more than this many packets waiting inside the decoder. */
const MAX_QUEUE = 8;

export interface StreamTrack {
  codec: string;
  width: number;
  height: number;
  description: Uint8Array;
  /** Container colour description (range!), passed to the decoder so a full-range picture is not read as limited. */
  colour?: ColourInfo | null;
}

/**
 * Sequential playback decode: ONE decoder run from the keyframe at (or before) `startIndex`, feeding packets in file order and
 * emitting frames in presentation order, so every frame is decoded exactly once (a seek-per-frame would re-decode the whole GOP each time).
 * Back-pressure: stops feeding while `maxBuffered` decoded frames are waiting for `next()` (the byte budget the player sets).
 * It owns its own decoder, so scrubbing through the media handle never disturbs it. `close()` frees every frame it still holds.
 */
export function openFrameStream(src: ByteSource, track: StreamTrack, table: FrameTable, startIndex: number, maxBuffered: number, stats: { received: number; closed: number }): FrameStream {
  const total = table.pts.length;
  const first = Math.min(Math.max(startIndex, 0), Math.max(total - 1, 0));
  const firstTs = table.pts[first] ?? 0;
  let fed = startPacket(table, first); // next packet to feed, in file order
  let closed = false;
  let ended = false;
  let failure: MediaDecodeError | undefined;
  const queue: VideoFrame[] = [];
  let waiter: (() => void) | undefined;
  let nextIndex = first;
  const wake = () => { const w = waiter; waiter = undefined; w?.(); };
  const closeFrame = (f: VideoFrame) => { f.close(); stats.closed++; };

  const dec = new VideoDecoder({
    output: (f) => {
      stats.received++;
      // Pre-roll frames (before the requested start) are decoded but never shown.
      if (closed || f.timestamp < firstTs) { closeFrame(f); return; }
      queue.push(f);
      wake();
    },
    error: (e) => {
      failure = new MediaDecodeError("io", `${codecName(track.codec)} decode failed: ${e.message}`);
      wake();
    },
  });
  const colorSpace = colourSpaceInit(track.colour);
  dec.configure({ codec: track.codec, codedWidth: track.width, codedHeight: track.height, ...(track.description.length ? { description: track.description } : {}), ...(colorSpace ? { colorSpace } : {}) });

  const pump = async () => {
    try {
      while (!closed && fed < table.packets.length) {
        // Back-pressure on both the decoder queue and the frames nobody has taken yet.
        while (!closed && (dec.decodeQueueSize > MAX_QUEUE || queue.length >= maxBuffered)) {
          await new Promise<void>((res) => {
            const t = setTimeout(res, 8); // wakes on a take as well (see next())
            dec.addEventListener("dequeue", () => { clearTimeout(t); res(); }, { once: true });
          });
        }
        if (closed) return;
        const batch = table.packets.slice(fed, fed + READ_BATCH);
        const bytes = await readPackets(src, batch, () => closed);
        for (let i = 0; i < batch.length && !closed; i++) {
          while (!closed && (dec.decodeQueueSize > MAX_QUEUE || queue.length >= maxBuffered)) {
            await new Promise<void>((res) => setTimeout(res, 4));
          }
          if (closed || dec.state === "closed") return;
          const p = batch[i]!;
          dec.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.ts, duration: p.dur, data: bytes[i]! }));
        }
        fed += batch.length;
      }
      if (!closed && dec.state === "configured") await dec.flush();
    } catch (e) {
      if (!closed) failure = e instanceof MediaDecodeError ? e : new MediaDecodeError("io", `${codecName(track.codec)} decode failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      ended = true;
      wake();
    }
  };
  void pump();

  return {
    async next(): Promise<DecodedFrame | null> {
      for (;;) {
        if (failure) throw failure;
        const f = queue.shift();
        if (f) {
          const index = nextIndex++;
          let released = false;
          return {
            kind: "gpu",
            frame: f,
            index,
            ptsTicks: usToTicks(f.timestamp),
            width: f.visibleRect?.width ?? f.codedWidth,
            height: f.visibleRect?.height ?? f.codedHeight,
            release: () => { if (!released) { released = true; closeFrame(f); } },
          };
        }
        if (ended || closed || nextIndex >= total) return null;
        await new Promise<void>((res) => { waiter = res; });
      }
    },
    buffered: () => queue.length,
    close() {
      if (closed) return;
      closed = true;
      for (const f of queue.splice(0)) closeFrame(f);
      if (dec.state !== "closed") dec.close();
      wake();
    },
  };
}
