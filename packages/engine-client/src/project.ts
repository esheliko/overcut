import type { Project } from "./model.generated";

/** Mirrors `app_model::SCHEMA_VERSION`; the browser smoke test opens a project made here in the real engine, so drift fails loudly. */
export const PROJECT_SCHEMA_VERSION = 3;

/** A random 128-bit id as 32 lowercase hex chars (the wire form of every id). */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** An empty project like `Project::new`: one 1080p30 sequence with a video and an audio track. */
export function newProject(name: string): Project {
  const track = (kind: "video" | "audio", label: string) => ({ id: newId(), kind, name: label, muted: false, locked: false, clips: [] });
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    id: newId(),
    name,
    media: [],
    sequences: [
      {
        id: newId(),
        name: "Sequence 1",
        frame_rate: { num: 30, den: 1 },
        resolution: { width: 1920, height: 1080 },
        sample_rate: 48_000,
        tracks: [track("video", "V1"), track("audio", "A1")],
      },
    ],
  };
}
