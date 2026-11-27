/**
 * How a decoded frame reaches the GPU is chosen per device by a micro-benchmark, never assumed (Intel UHD 630, Chrome 157: copyExternalImageToTexture
 * 5.9 ms p50, zero-copy importExternalTexture 22.8 ms, CPU upload 27 ms; docs/adr/0004-media-io.md). Pure logic here; the Worker measures
 * (`worker.ts`) and the UI thread keeps the cache in local storage (`host.ts`; Workers have none).
 */

/** `frame`: hand the `VideoFrame` to the compositor (WebGPU `copyExternalImageToTexture`, WebGL2 `texImage2D(VideoFrame)`). `cpu`: `copyTo` RGBA and upload the bytes. */
export type UploadPath = "frame" | "cpu";
export const UPLOAD_PATHS: readonly UploadPath[] = ["frame", "cpu"];

export interface UploadChoice {
  path: UploadPath;
  /** p50 per path in ms (absent = that path failed on this device). */
  ms: Partial<Record<UploadPath, number>>;
  /** `measured` now, `cached` from an earlier run on this GPU and browser version, `default` when nothing could be measured. */
  source: "measured" | "cached" | "default";
}

/** The browser and its version, e.g. `Chrome/157.0.0.0`: the cache is re-measured when it changes. */
export function browserVersion(ua: string): string {
  const m = /(Edg|CriOS|Firefox|Chrome|Version)\/([\d.]+)/.exec(ua);
  return m ? `${m[1]}/${m[2]}` : "unknown";
}

/**
 * Version of the measuring method. Part of the cache key, so a value measured by an older method is measured again.
 * v2 (M2 W7): the Galaxy S24 cached `cpu` (frame 45 ms vs cpu 28 ms) while its own bench had `texImage2D(VideoFrame)` at 9.5 ms and the CPU copy at 68 ms:
 * the v1 run measured while the first clip was being decoded and played, and one path after the other. v2 measures when the player is idle, both
 * paths interleaved, and discards a run that was disturbed.
 */
export const UPLOAD_METHOD = 2;

/** One cache entry per backend, GPU, browser version and measuring method. */
export const uploadKey = (backend: string, adapter: string, ua: string): string => `${backend}|${adapter}|${browserVersion(ua)}|v${UPLOAD_METHOD}`;

/** How much faster (ratio of p50s) the CPU path must be before it replaces the frame path, which needs no CPU copy and has never lost on a real device. */
export const CPU_MUST_BEAT = 0.75;

/** The faster path by p50. The frame path wins unless the CPU path is clearly (25%) faster; a failed path never wins; nothing measurable = `frame`. */
export function pickPath(ms: Partial<Record<UploadPath, number | null>>): UploadPath {
  const f = ms.frame ?? null;
  const c = ms.cpu ?? null;
  if (f === null && c === null) return "frame";
  if (f === null) return "cpu";
  if (c === null) return "frame";
  return c < f * CPU_MUST_BEAT ? "cpu" : "frame";
}

/** A stored value, validated (storage is untrusted: a bad entry is simply ignored and measured again). */
export function parseChoice(raw: unknown): UploadChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { path?: unknown; ms?: unknown };
  if (r.path !== "frame" && r.path !== "cpu") return null;
  const ms: Partial<Record<UploadPath, number>> = {};
  if (r.ms && typeof r.ms === "object") for (const p of UPLOAD_PATHS) { const v = (r.ms as Record<string, unknown>)[p]; if (typeof v === "number" && Number.isFinite(v)) ms[p] = v; }
  return { path: r.path, ms, source: "cached" };
}

export interface ChooseOptions {
  key: string;
  /** The stored value for `key`, if any. May reject: then it is measured. */
  cached(key: string): Promise<unknown>;
  save(key: string, value: UploadChoice): void;
  /** p50 in ms of one upload path on this device, or null when it fails. Must not throw (a throw counts as a failed path). */
  measure(path: UploadPath): Promise<number | null>;
  /** Both paths in one go, interleaved (so load on the device hits both alike). Preferred over `measure` when given. */
  measureAll?(): Promise<Partial<Record<UploadPath, number | null>>>;
  /** Asked after measuring: false when something disturbed the run (playback started): the result is thrown away, not stored, and the caller measures again later. */
  undisturbed?(): boolean;
}

export async function chooseUploadPath(o: ChooseOptions): Promise<UploadChoice> {
  const stored = parseChoice(await o.cached(o.key).catch(() => null));
  if (stored) return stored;
  const ms: Partial<Record<UploadPath, number>> = {};
  if (o.measureAll) {
    const all = await o.measureAll().catch((): Partial<Record<UploadPath, number | null>> => ({}));
    for (const p of UPLOAD_PATHS) { const v = all[p]; if (typeof v === "number" && Number.isFinite(v)) ms[p] = v; }
  } else {
    for (const p of UPLOAD_PATHS) {
      const v = await o.measure(p).catch(() => null);
      if (v !== null && Number.isFinite(v)) ms[p] = v;
    }
  }
  if (o.undisturbed && !o.undisturbed()) return { path: "frame", ms, source: "default" };
  const measuredAny = Object.keys(ms).length > 0;
  const choice: UploadChoice = { path: pickPath(ms), ms, source: measuredAny ? "measured" : "default" };
  if (measuredAny) o.save(o.key, choice); // a run where nothing worked is not remembered
  return choice;
}

export const median = (a: readonly number[]): number => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };

/** Local storage entry (UI thread only): `{ [key]: UploadChoice }`. */
export const UPLOAD_STORE = "overcut.uploadPath";

/** Everything stored, for the device report (`null` when storage is blocked or empty). */
export function readStoredChoices(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(UPLOAD_STORE);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch { return null; }
}
