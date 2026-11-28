/** Bin posters kept on the device by the media's content id, so cards show their picture right after a reload, before any file access is granted.
 *  OPFS (memory where there is none), least-recently-used out first, at most `POSTER_CAP_BYTES` (a poster is ~15 KB: about 2,000 of them).
 *  Derived data: losing it only costs the picture. Filmstrip thumbnails use the same idea in `thumbs.ts` (their cache, 256 MB, is keyed by the same id). */
import type { MediaRef } from "@app/engine-client";
import { MediaCache, defaultStore, fingerprint } from "./cache";

export const POSTER_CAP_BYTES = 32 * 1024 * 1024;

let cache: MediaCache | null = null;
const poster = (): MediaCache => (cache ??= new MediaCache(defaultStore("overcut-posters"), POSTER_CAP_BYTES));
const keyOf = (m: Pick<MediaRef, "hash" | "uri">) => `poster/${fingerprint(m)}`;

/** Remembers a poster picture. Never throws. */
export async function savePoster(m: Pick<MediaRef, "hash" | "uri">, blob: Blob): Promise<void> {
  try {
    await poster().put(keyOf(m), new Uint8Array(await blob.arrayBuffer()));
  } catch { /* the card keeps its icon after a reload */ }
}

/** An object URL of the remembered poster (the caller revokes it), or `undefined`. */
export async function loadPoster(m: Pick<MediaRef, "hash" | "uri">): Promise<string | undefined> {
  try {
    const b = await poster().get(keyOf(m));
    return b ? URL.createObjectURL(new Blob([b as unknown as BlobPart], { type: "image/jpeg" })) : undefined;
  } catch { return undefined; }
}
