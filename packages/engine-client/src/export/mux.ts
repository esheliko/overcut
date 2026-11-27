import { EncodedAudioPacketSource, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat, type StreamTargetChunk } from "mediabunny";
import type { AudioCodecName, VideoCodecName } from "./presets";

/**
 * The narrow door to the container writer (ADR 0004: swappable). Today it is Mediabunny (MPL-2.0, the maintained successor of mp4-muxer and
 * webm-muxer, which are deprecated in its favour). Everything the rest of the export code knows about muxing is this interface.
 */
export interface Muxer {
  /** Chunks must arrive in decode order per track. The promise resolves when the muxer (and storage behind it) can take more. */
  addVideo(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): Promise<void>;
  addAudio(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): Promise<void>;
  /** Writes the index and the last bytes. The target stream is closed. */
  finalize(): Promise<void>;
  /** Stops without writing the index. */
  cancel(): Promise<void>;
  mime(): Promise<string>;
}

export interface MuxerOptions {
  container: "mp4" | "webm";
  videoCodec: VideoCodecName;
  audioCodec: AudioCodecName;
  /** Frames per second of the video track (timestamps snap to it). */
  frameRate: number;
  /** Upper bounds on packets per track; sizes the reserved index of a fast-start MP4. */
  maxVideoPackets: number;
  maxAudioPackets: number;
  /** Where the picture ends, in seconds: the sound is cut there (`fitAudioPacket`). Omit to keep every packet. */
  endSeconds?: number;
  /** Creation time metadata; default: now. */
  creationTime?: Date;
  /** Positioned writes (the muxer seeks back to patch headers). Closed by `finalize`. */
  target: WritableStream<StreamTargetChunk>;
}

/** Bytes buffered before a write reaches storage: the whole of the muxer's memory use, whatever the file size. */
export const WRITE_CHUNK_BYTES = 4 << 20;

export async function createMuxer(o: MuxerOptions): Promise<Muxer> {
  // MP4: `reserve` puts the index at the start (plays before it is fully downloaded) without holding the file in memory; WebM streams as clusters.
  const format = o.container === "mp4" ? new Mp4OutputFormat({ fastStart: "reserve" }) : new WebMOutputFormat();
  const output = new Output({ format, target: new StreamTarget(o.target, { chunked: true, chunkSize: WRITE_CHUNK_BYTES }) });
  const video = new EncodedVideoPacketSource(o.videoCodec);
  const audio = new EncodedAudioPacketSource(o.audioCodec);
  if (o.creationTime) output.setMetadataTags({ creationTime: o.creationTime });
  output.addVideoTrack(video, { frameRate: o.frameRate, maximumPacketCount: o.maxVideoPackets });
  output.addAudioTrack(audio, { maximumPacketCount: o.maxAudioPackets });
  await output.start();
  return {
    addVideo: (chunk, meta) => video.add(EncodedPacket.fromEncodedChunk(chunk), meta),
    addAudio: async (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      const fit = fitAudioPacket(packet.timestamp, packet.duration, o.endSeconds);
      if (fit === null) return; // after the picture's last frame: the encoder's padding packet
      await audio.add(fit === packet.duration ? packet : packet.clone({ duration: fit }), meta);
    },
    finalize: () => output.finalize(),
    cancel: () => output.cancel(),
    mime: () => output.getMimeType(),
  };
}

/**
 * What to do with an encoded audio packet at `timestamp` of `duration` (seconds) when the picture ends at `end`: `null` = drop it (it starts at or after the end),
 * else the duration to keep (cut back so the track ends with the picture). The Opus encoder flushes a last, padded 20 ms packet past the final sample, which
 * made the audio 20 ms longer than the video (#138). Without an `end` every packet is kept as it is.
 */
export function fitAudioPacket(timestamp: number, duration: number, end: number | undefined): number | null {
  if (end === undefined) return duration;
  const eps = 1e-9;
  if (timestamp >= end - eps) return null;
  return Math.min(duration, end - timestamp);
}

/** Audio packets are at most one per 480 samples (Opus 10 ms) in practice 960/1024; the bound adds a third on top, as the library advises. */
export const maxAudioPackets = (samples: number): number => Math.ceil((samples / 480) * 1.34) + 32;
