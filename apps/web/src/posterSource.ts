/**
 * The bridge between the open project's preview and the projects list (`docs/features/projects.md`, "poster"): the preview registers a function
 * that asks its Worker for a small JPEG of the frame at the playhead; the app calls `capturePoster` when it saves the project's row. Fails soft:
 * no preview, no frame, a black frame or a timeout all mean `null`, and the card keeps its previous poster or its placeholder.
 */
type Source = () => Promise<Blob | null>;
let source: Source | null = null;

export function setPosterSource(next: Source | null): void { source = next; }

const toDataUrl = (blob: Blob): Promise<string | null> =>
  new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" && r.result.startsWith("data:image/jpeg;base64,") ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });

/** A `data:image/jpeg` URL of the current frame, or `null`. Never throws and never waits longer than `ms`. */
export async function capturePoster(ms = 1500): Promise<string | null> {
  const get = source;
  if (!get) return null;
  try {
    const blob = await Promise.race([get(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    return blob ? await toDataUrl(blob) : null;
  } catch {
    return null;
  }
}

/** Only a JPEG data URL of sane size is ever used as a picture source (the list is read from storage the app does not fully control). */
export const validPoster = (p: unknown): p is string => typeof p === "string" && p.length < 40_000 && p.startsWith("data:image/jpeg;base64,");
