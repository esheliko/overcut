import { resolvePreset, webCodecsProbe, type CodecProbe } from "./presets";
import type { ExportPlan } from "./plan";
import type { ExportAudioCodec, ExportContainer, ExportVideoCodec } from "./types";

/** The formats the export dialog offers. Each is offered only when this device's encoder accepts it at the asked size and frame rate. */
export type ExportFormatId = "mp4-h264" | "webm-vp9" | "webm-av1";

export interface ExportFormatOption {
  id: ExportFormatId;
  container: Exclude<ExportContainer, "auto">;
  videoCodec: Exclude<ExportVideoCodec, "auto">;
  /** The audio codec the export will use for this format (AAC where the device has it, else Opus). */
  audioCodec: Exclude<ExportAudioCodec, "auto">;
  /** Plain-English catches (limited player support). Empty for the best choices. */
  warnings: string[];
}

export interface ExportFormats {
  options: ExportFormatOption[];
  /** The one the plain "Export" button uses (ADR 0004 order), or null when the device cannot encode anything. */
  auto: ExportFormatId | null;
}

const FORMATS: { id: ExportFormatId; container: "mp4" | "webm"; videoCodec: "h264" | "vp9" | "av1" }[] = [
  { id: "mp4-h264", container: "mp4", videoCodec: "h264" },
  { id: "webm-vp9", container: "webm", videoCodec: "vp9" },
  { id: "webm-av1", container: "webm", videoCodec: "av1" },
];
const VIDEO_TO_NAME = { avc: "h264", vp9: "vp9", av1: "av1" } as const;

/**
 * Asks the browser's `isConfigSupported` which formats it can encode at `width` x `height` and `fps`, with the same preset resolver the export
 * itself uses, so what is offered cannot fail for lack of an encoder. Never throws; a device with no encoder gets `{ options: [], auto: null }`.
 */
export async function probeExportFormats(size: { width: number; height: number; fps: number }, probe: CodecProbe = webCodecsProbe): Promise<ExportFormats> {
  const fpsNum = Math.round(size.fps * 1000);
  const plan = { width: size.width, height: size.height, fpsNum, fpsDen: 1000, sampleRate: 48000 } as ExportPlan;
  // All four questions go to the browser at once (each isConfigSupported is its own round trip): the slowest one sets the time, not their sum.
  const [tried, autoTry] = await Promise.all([
    Promise.all(FORMATS.map(async (f) => {
      try {
        const r = await resolvePreset(plan, { sequence: "", container: f.container, videoCodec: f.videoCodec }, probe);
        return { id: f.id, container: f.container, videoCodec: f.videoCodec, audioCodec: r.audioCodec, warnings: r.warnings } as ExportFormatOption; // not encodable here: not offered
      } catch { return null; }
    })),
    resolvePreset(plan, { sequence: "" }, probe).then((r) => r, () => null),
  ]);
  const options = tried.filter((o): o is ExportFormatOption => o !== null);
  let auto: ExportFormatId | null;
  if (autoTry) {
    const hit = options.find((o) => o.container === autoTry.container && o.videoCodec === VIDEO_TO_NAME[autoTry.videoCodec]);
    auto = (hit ?? options[0])?.id ?? null;
  } else auto = options[0]?.id ?? null;
  return { options, auto };
}
