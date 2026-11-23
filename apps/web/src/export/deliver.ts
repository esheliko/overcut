/** Getting the finished file to the person: the save picker where the browser has one, else a download; the share sheet where it can take files. Both take the
 *  browser objects as arguments so they are testable. */

type PickerWindow = {
  showSaveFilePicker?: (o: { suggestedName: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }> }>;
  document: { createElement(t: "a"): { href: string; download: string; rel: string; click(): void; remove(): void }; body: { append(a: unknown): void } };
  URL: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
  setTimeout: typeof setTimeout;
};

export type SaveOutcome = "saved" | "downloaded" | "dismissed";

/** `saved`: written where the person chose. `downloaded`: handed to the browser's download. `dismissed`: they closed the picker. */
export async function saveFile(file: File, win: PickerWindow = window as unknown as PickerWindow): Promise<SaveOutcome> {
  if (typeof win.showSaveFilePicker === "function") {
    let handle;
    try {
      const ext = file.name.slice(file.name.lastIndexOf("."));
      handle = await win.showSaveFilePicker({ suggestedName: file.name, types: [{ accept: { [file.type.split(";")[0] || "video/mp4"]: [ext] } }] });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "dismissed";
      throw e;
    }
    const w = await handle.createWritable();
    try {
      await w.write(file); // a Blob is streamed to disk, not read into memory
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => undefined);
      throw e;
    }
    return "saved";
  }
  const url = win.URL.createObjectURL(file);
  const a = win.document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  win.document.body.append(a);
  a.click();
  a.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

type ShareNav = { canShare?(d: { files: File[] }): boolean; share?(d: { files: File[]; title?: string }): Promise<void> };

/** True when the browser's share sheet can take this file (phones, some desktops). */
export function canShareFile(file: File, nav: ShareNav = navigator as unknown as ShareNav): boolean {
  try { return typeof nav.share === "function" && nav.canShare?.({ files: [file] }) === true; } catch { return false; }
}

/** `shared`, or `dismissed` when the person closed the share sheet. Other failures throw. */
export async function shareFile(file: File, title: string, nav: ShareNav = navigator as unknown as ShareNav): Promise<"shared" | "dismissed"> {
  try {
    await nav.share!({ files: [file], title });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "dismissed";
    throw e;
  }
}
