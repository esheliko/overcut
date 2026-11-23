/**
 * Saving and opening a `.overcut` file from the browser or the desktop app (PM-07, `docs/features/project-file.md`). The bytes come from and go to
 * the engine (`Engine.saveProject` / `openProject`); this file only moves them to and from the user's disk. Never throws for a cancelled dialog.
 */
import { getDesktop } from "./media/sources";
import { PROJECT_EXT } from "./projectName";

export { nameOfFile, projectFileName } from "./projectName";

type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
type OpenPicker = (o: { multiple: false; types: { description: string; accept: Record<string, string[]> }[]; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>;
type PickerWindow = Window & { showSaveFilePicker?: SavePicker; showOpenFilePicker?: OpenPicker };

const TYPES = [{ description: "OverCut project", accept: { "application/octet-stream": [".overcut"] } }];

const aborted = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/**
 * "Save project as...": the system dialog in the desktop app, the File System Access save picker in Chromium, else a download (a plain
 * `<a download>`). Resolves to the saved file's name, or `null` when the person cancelled.
 */
export async function saveProjectBytes(bytes: Uint8Array, suggested: string): Promise<string | null> {
  const desktop = getDesktop();
  if (desktop) {
    const path = await desktop.saveProject(bytes, suggested);
    return path ? path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) : null;
  }
  const w = window as PickerWindow;
  if (typeof w.showSaveFilePicker === "function") {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: suggested, types: TYPES });
      const out = await handle.createWritable();
      await out.write(bytes as BlobPart);
      await out.close();
      return handle.name;
    } catch (e) {
      if (aborted(e)) return null;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggested;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return suggested;
}

/** "Open project...": the system dialog (desktop), the open picker (Chromium), else a throwaway file input. `null` when cancelled. */
export async function pickProjectFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const desktop = getDesktop();
  if (desktop) return desktop.openProject();
  const w = window as PickerWindow;
  if (typeof w.showOpenFilePicker === "function") {
    try {
      const [h] = await w.showOpenFilePicker({ multiple: false, types: TYPES });
      if (!h) return null;
      const file = await h.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch (e) {
      if (aborted(e)) return null;
      throw e;
    }
  }
  return new Promise((ok, fail) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${PROJECT_EXT},application/octet-stream,application/zip`;
    input.setAttribute("data-testid", "project-file-input");
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return ok(null);
      file.arrayBuffer().then((b) => ok({ name: file.name, bytes: new Uint8Array(b) }), fail);
    };
    input.oncancel = () => ok(null);
    input.click();
  });
}
