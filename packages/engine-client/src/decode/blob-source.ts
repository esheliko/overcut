/** Random-access bytes over a `Blob`/`File`: range reads via `Blob.slice`, so a large file is never loaded whole. Mirrors `JsSource` in crates/wasm. */
export interface ByteSource {
  readonly length: number;
  read(offset: number, len: number): Promise<Uint8Array>;
}

export function blobSource(blob: Blob): ByteSource {
  return {
    length: blob.size,
    read: async (offset, len) => {
      const end = Math.min(blob.size, offset + len);
      if (offset < 0 || offset > blob.size) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

/** One packet as the engine sends it (`packets_json` in crates/wasm/src/media.rs). */
export interface PacketJson {
  offset: number;
  size: number;
  key: boolean;
  /** Presentation time, microseconds. */
  ts: number;
  dur: number;
}

/** Largest single read when packets are fetched as one contiguous range (bigger spans fall back to per-packet reads). */
const MAX_SPAN = 32 * 1024 * 1024;

/**
 * Bytes of `packets` in order. Neighbouring packets (a GOP is contiguous in MP4/WebM) are read with one `Blob.slice`;
 * a span larger than 32 MiB or with big gaps is read packet by packet. `isStale` aborts between reads (cancelled seek).
 */
export async function readPackets(src: ByteSource, packets: readonly PacketJson[], isStale: () => boolean): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array<Uint8Array>(packets.length);
  let i = 0;
  while (i < packets.length) {
    if (isStale()) throw new DOMException("stale", "AbortError");
    const first = packets[i]!;
    let j = i;
    let end = first.offset + first.size;
    let used = first.size;
    while (j + 1 < packets.length) {
      const n = packets[j + 1]!;
      const nEnd = Math.max(end, n.offset + n.size);
      const start = Math.min(first.offset, n.offset);
      if (nEnd - start > MAX_SPAN || nEnd - start > 2 * (used + n.size) + 4096) break;
      end = nEnd;
      used += n.size;
      j++;
    }
    const span = packets.slice(i, j + 1);
    const start = Math.min(...span.map((p) => p.offset));
    const bytes = await src.read(start, end - start);
    for (let k = 0; k < span.length; k++) {
      const p = span[k]!;
      const slice = bytes.subarray(p.offset - start, p.offset - start + p.size);
      if (slice.length !== p.size) throw new Error("the file ended in the middle of a packet");
      out[i + k] = slice;
    }
    i = j + 1;
  }
  return out;
}
