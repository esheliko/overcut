import { codecName, MediaDecodeError, unsupported } from "./errors";
import { readPackets, type ByteSource, type PacketJson } from "./blob-source";
import { assemble, type AudioBlock } from "./resample";
import { avcLengthSize, packetsToDecode, readBatches } from "./seek-plan";

/** Everything the host needs to open the two decoders; filled from the probe (`MediaFile.info()`, `videoDescription()`). */
export interface HostTracks {
  video?: { codec: string; width: number; height: number; description: Uint8Array };
  audio?: { codec: string; sampleRate: number; channels: number; description: Uint8Array };
}

export interface HostStats {
  /** Frames the video decoder produced. */
  received: number;
  /** Frames closed (dropped intermediates, cancelled work, released results). `received - closed` = frames still open. */
  closed: number;
  open: number;
}

/** In-flight decodes at most this far ahead of the decoder (`decodeQueueSize`): bounds memory and lets a cancel take effect quickly. */
const MAX_QUEUE = 8;

const cancelled = () => new MediaDecodeError("cancelled", "cancelled");
const isAbort = (e: unknown) => e instanceof DOMException && (e.name === "AbortError" || e.name === "InvalidStateError");

/**
 * The WebCodecs backend behind `HostDecoder` (the `JsHost` surface in crates/wasm/src/media.rs). Runs in whatever scope it is
 * created in (the engine Worker in the app). Works only through the web platform; the engine never sees a `VideoFrame`'s pixels.
 *
 * Seek: reset, configure, feed packets from the keyframe through the target in decode order, `flush()`, keep the frame whose
 * timestamp is the target and close every other (S1 proven). `cancel()` makes the running request fail with `cancelled` at once
 * (decoder reset), so scrubbing never queues stale work.
 */
export class WebCodecsHost {
  private gen = 0;
  private vdec: VideoDecoder | undefined;
  private adec: AudioDecoder | undefined;
  private sink: { gen: number; target: number; found: VideoFrame | undefined } | undefined;
  private table = new Map<number, VideoFrame>();
  private nextId = 1;
  private received = 0;
  private closed = 0;
  private readonly gpu: boolean;

  /** Use `WebCodecsHost.create`: it validates the codecs first so an unsupported file fails at open, naming the codec. */
  private constructor(private readonly src: ByteSource, private readonly tracks: HostTracks, preferGpu: boolean) {
    this.gpu = preferGpu;
  }

  static async create(src: ByteSource, tracks: HostTracks, opts: { preferGpu?: boolean } = {}): Promise<WebCodecsHost> {
    if (tracks.video) {
      if (typeof VideoDecoder === "undefined") throw new MediaDecodeError("unsupported", "This browser has no WebCodecs video decoder. Use a current Chrome, Edge, Safari or Firefox.");
      const cfg = videoConfig(tracks.video);
      const r = await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
      if (!r.supported) throw unsupported("video", tracks.video.codec);
    }
    if (tracks.audio) {
      if (typeof AudioDecoder === "undefined") throw new MediaDecodeError("unsupported", "This browser has no WebCodecs audio decoder. Use a current Chrome, Edge, Safari or Firefox.");
      const r = await AudioDecoder.isConfigSupported(audioConfig(tracks.audio)).catch(() => ({ supported: false }));
      if (!r.supported) throw unsupported("audio", tracks.audio.codec);
    }
    return new WebCodecsHost(src, tracks, opts.preferGpu ?? true);
  }

  stats(): HostStats {
    return { received: this.received, closed: this.closed, open: this.received - this.closed };
  }

  // --- JsHost surface ------------------------------------------------------------------------------------------------

  hasGpu(): boolean {
    return this.gpu && typeof VideoFrame !== "undefined";
  }

  /** Free the frame behind a GPU handle (called when the last Rust clone drops). */
  release(id: number): void {
    const f = this.table.get(id);
    if (!f) return;
    this.table.delete(id);
    this.close(f);
  }

  /** The `VideoFrame` behind a GPU handle, for the renderer's texture import. Valid until `release`. */
  frame(id: number): VideoFrame | undefined {
    return this.table.get(id);
  }

  /** Supersede whatever video decode is running: it rejects with `cancelled` and its frames are closed. */
  cancel(): void {
    this.gen++;
    // Only a decode in flight needs the reset: an idle (flushed) decoder stays configured, so the next seek skips reset + configure.
    if (this.sink && this.vdec && this.vdec.state === "configured") this.vdec.reset();
    if (this.sink?.found) this.close(this.sink.found);
    if (this.sink) this.sink.found = undefined;
  }

  /** Free decoders and every held frame. */
  dispose(): void {
    this.gen++;
    for (const f of [...this.table.values()]) this.close(f);
    this.table.clear();
    if (this.vdec && this.vdec.state !== "closed") this.vdec.close();
    if (this.adec && this.adec.state !== "closed") this.adec.close();
  }

  async decodeVideo(requestJson: string, gpu: boolean): Promise<{ width: number; height: number; id?: number; data?: Uint8Array }> {
    const track = this.tracks.video;
    if (!track) throw new MediaDecodeError("invalid", "no video track");
    const req = JSON.parse(requestJson) as { target: number; packets: PacketJson[] };
    const gen = ++this.gen;
    const stale = () => gen !== this.gen;
    const dec = this.videoDecoder(track);
    if (dec.state !== "configured") dec.configure(videoConfig(track)); // reuse the configured decoder (hardware decoders are slow to re-create)
    const sink: NonNullable<WebCodecsHost["sink"]> = { gen, target: req.target, found: undefined };
    this.sink = sink;
    let pending: Promise<Uint8Array[]> | undefined;
    try {
      // Read the run in growing batches: the keyframe's batch is small, so the decoder starts while the rest is still being read.
      const lenSize = avcLengthSize(track.codec, track.description);
      const batches = readBatches(req.packets.length);
      let from = 0;
      const read = (b: number) => {
        const slice = req.packets.slice(from, from + batches[b]!);
        from += batches[b]!;
        return readPackets(this.src, slice, stale);
      };
      pending = read(0);
      let at = 0;
      for (let b = 0; b < batches.length; b++) {
        const bytes = await pending!;
        const batch = req.packets.slice(at, at + batches[b]!);
        pending = b + 1 < batches.length ? read(b + 1) : undefined;
        at += batches[b]!;
        // The last packet of the run is the target (kept); non-reference pictures before it are never decoded.
        const keep = packetsToDecode(batch, bytes, lenSize, at === req.packets.length);
        for (const i of keep) {
          if (stale()) throw cancelled();
          // Back-pressure: never more than MAX_QUEUE packets waiting in the decoder.
          while (dec.decodeQueueSize > MAX_QUEUE) {
            await new Promise<void>((res) => dec.addEventListener("dequeue", () => res(), { once: true }));
            if (stale()) throw cancelled();
          }
          const p = batch[i]!;
          dec.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.ts, duration: p.dur, data: bytes[i]! }));
        }
      }
      await dec.flush();
      if (stale()) throw cancelled();
      const frame = sink.found;
      sink.found = undefined;
      if (!frame) throw new MediaDecodeError("io", `${codecName(track.codec)} decoder produced no frame for the requested time`);
      const width = frame.visibleRect?.width ?? frame.codedWidth;
      const height = frame.visibleRect?.height ?? frame.codedHeight;
      if (gpu) {
        const id = this.nextId++;
        this.table.set(id, frame);
        return { width, height, id };
      }
      try {
        const data = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
        await frame.copyTo(data, { format: "RGBA" });
        return { width, height, data };
      } finally {
        this.close(frame);
      }
    } catch (e) {
      pending?.catch(() => undefined); // a read still running for a cancelled seek: its rejection is not news
      if (sink.found) this.close(sink.found);
      sink.found = undefined;
      if (e instanceof MediaDecodeError) throw e;
      if (stale()) throw cancelled(); // reset() aborts a pending flush with AbortError
      if (isAbort(e)) throw cancelled();
      throw new MediaDecodeError("io", `${codecName(track.codec)} decode failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (this.sink === sink) this.sink = undefined;
    }
  }

  async decodeAudio(requestJson: string): Promise<Float32Array> {
    const track = this.tracks.audio;
    if (!track) throw new MediaDecodeError("invalid", "no audio track");
    const req = JSON.parse(requestJson) as { start: number; count: number; rate: number; fromStart: boolean; packets: PacketJson[] };
    const blocks: AudioBlock[] = [];
    const dec = this.audioDecoder(track, (d) => {
      try {
        const planes: Float32Array[] = [];
        for (let c = 0; c < d.numberOfChannels; c++) {
          const p = new Float32Array(d.numberOfFrames);
          d.copyTo(p, { planeIndex: c, format: "f32-planar" });
          planes.push(p);
        }
        blocks.push({ ts: d.timestamp, planes });
      } finally {
        d.close();
      }
    });
    dec.reset();
    dec.configure(audioConfig(track));
    try {
      const bytes = await readPackets(this.src, req.packets, () => false);
      for (let i = 0; i < req.packets.length; i++) {
        while (dec.decodeQueueSize > MAX_QUEUE) await new Promise<void>((res) => dec.addEventListener("dequeue", () => res(), { once: true }));
        const p = req.packets[i]!;
        dec.decode(new EncodedAudioChunk({ type: "key", timestamp: p.ts, duration: p.dur, data: bytes[i]! }));
      }
      await dec.flush();
    } catch (e) {
      if (e instanceof MediaDecodeError) throw e;
      throw new MediaDecodeError("io", `${codecName(track.codec)} decode failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Opus: the decoder drops the stream's pre-skip from the first output after every configure(). Decoding from mid-stream that
    // shifts all output earlier by the pre-skip, so put it back (at the start of the stream the drop is the correct one).
    const shift = !req.fromStart && track.codec === "opus" ? opusPreSkip(track.description) : 0;
    return assemble(blocks, track.sampleRate, track.channels, req.start, req.count, req.rate, shift);
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  private close(f: VideoFrame): void {
    f.close();
    this.closed++;
  }

  private videoDecoder(track: NonNullable<HostTracks["video"]>): VideoDecoder {
    this.vdec ??= new VideoDecoder({
      output: (frame) => {
        this.received++;
        const s = this.sink;
        // Keep only the target of the live request; every intermediate (pre-roll, reorder) and every stale frame is closed now.
        if (s && s.gen === this.gen && !s.found && frame.timestamp === s.target) s.found = frame;
        else this.close(frame);
      },
      error: (e) => {
        this.vdec = undefined; // a decoder that errored is closed for good; the next request builds a new one
        void e;
      },
    });
    if (this.vdec.state === "closed") {
      this.vdec = undefined;
      return this.videoDecoder(track);
    }
    return this.vdec;
  }

  private audioDecoder(track: NonNullable<HostTracks["audio"]>, output: (d: AudioData) => void): AudioDecoder {
    if (this.adec && this.adec.state !== "closed") this.adec.close(); // fresh output sink per request; audio decoders are cheap
    this.adec = new AudioDecoder({ output, error: () => undefined });
    void track;
    return this.adec;
  }
}

/** Pre-skip samples (48 kHz) from an `OpusHead` description (bytes 10-11, little endian). */
function opusPreSkip(head: Uint8Array): number {
  return head.length >= 12 ? head[10]! | (head[11]! << 8) : 0;
}

function videoConfig(t: NonNullable<HostTracks["video"]>): VideoDecoderConfig {
  return { codec: t.codec, codedWidth: t.width, codedHeight: t.height, ...(t.description.length ? { description: t.description } : {}) };
}

function audioConfig(t: NonNullable<HostTracks["audio"]>): AudioDecoderConfig {
  return { codec: t.codec, sampleRate: t.sampleRate, numberOfChannels: t.channels, ...(t.description.length ? { description: t.description } : {}) };
}
