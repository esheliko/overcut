import type { Engine, Op } from "./types";
import type { MediaId, Project } from "./model.generated";

/** Size of the head and tail windows (`FINGERPRINT_WINDOW` in `crates/model/src/file.rs`). */
export const FINGERPRINT_WINDOW = 64 * 1024;

/** The slice of a `File`/`Blob` the fingerprint needs. */
export interface Sliceable {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Fingerprints a file on import: reads at most 128 KiB, however big the file is. */
export async function fingerprintFile(engine: Pick<Engine, "fingerprintMedia">, file: Sliceable): Promise<string> {
  const w = Math.min(FINGERPRINT_WINDOW, file.size);
  const [first, last] = await Promise.all([file.slice(0, w).arrayBuffer(), file.slice(file.size - w, file.size).arrayBuffer()]);
  return engine.fingerprintMedia(file.size, new Uint8Array(first), new Uint8Array(last));
}

/** A file found while scanning for moved media: where it is now (`uri`, project-relative) and how to read it. */
export interface Candidate extends Sliceable {
  readonly uri: string;
}

/** Size recorded in a fingerprint (`b3-64k:<size>:<hash>`), for the free "same size?" pre-check. */
export function fingerprintSize(fp: string): number | null {
  const m = /^b3-64k:(\d+):/.exec(fp);
  return m ? Number(m[1]) : null;
}

export interface RelinkResult {
  /** `set_media` ops to apply (as one undo step): the file moved, here is its new uri. */
  ops: Op[];
  /** Media still not found: shown as offline; the reference and every clip stay. */
  offline: MediaId[];
}

/**
 * Relink by fingerprint (`docs/features/project-file.md`): for each media that has a fingerprint, keep it when the file at its `uri` still
 * matches; else look among `candidates` (same size first, each file hashed at most once) and propose its new uri. Media without a
 * fingerprint can only match on `uri` and are left alone. `current(uri)` returns the candidate that sits at a media's recorded uri, if any.
 */
export async function relinkMedia(
  engine: Pick<Engine, "fingerprintMedia">,
  project: Project,
  candidates: readonly Candidate[],
  current: (uri: string) => Candidate | undefined,
): Promise<RelinkResult> {
  const cache = new Map<Candidate, Promise<string>>();
  const hash = (c: Candidate) => {
    let p = cache.get(c);
    if (!p) cache.set(c, (p = fingerprintFile(engine, c)));
    return p;
  };
  const ops: Op[] = [];
  const offline: MediaId[] = [];
  for (const m of project.media) {
    const want = m.hash ?? null;
    if (!want) continue;
    const here = current(m.uri);
    if (here && fingerprintSize(want) === here.size && (await hash(here)) === want) continue;
    const size = fingerprintSize(want);
    let found: Candidate | undefined;
    for (const c of candidates) {
      if (c.size === size && (await hash(c)) === want) {
        found = c;
        break;
      }
    }
    if (found) ops.push({ op: "set_media", media: m.id, uri: found.uri, hash: want });
    else offline.push(m.id);
  }
  return { ops, offline };
}
