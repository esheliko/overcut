import { ExportError, type ExportSettings } from "./types";
import type { ExportPlan } from "./plan";

/** Mediabunny codec names. */
export type VideoCodecName = "avc" | "vp9" | "av1";
export type AudioCodecName = "aac" | "opus";

/** What the browser can encode. The real probe wraps `VideoEncoder.isConfigSupported`; tests pass a fake. */
export interface CodecProbe {
  video(config: VideoEncoderConfig): Promise<boolean>;
  audio(config: AudioEncoderConfig): Promise<boolean>;
}

export interface ResolvedPreset {
  container: "mp4" | "webm";
  videoCodec: VideoCodecName;
  audioCodec: AudioCodecName;
  video: VideoEncoderConfig;
  audio: AudioEncoderConfig;
  /** Shown to the user when the choice has a catch. */
  warnings: string[];
}

/** Codec string per size: the level must cover the frame size and rate or the encoder rejects the config. */
export function videoCodecString(codec: VideoCodecName, w: number, h: number, fps: number, profile: "high" | "main" | "baseline" = "high"): string {
  const pixelRate = w * h * fps;
  const big = pixelRate > 1920 * 1088 * 31; // above 1080p30
  switch (codec) {
    case "avc": {
      const level = big ? "33" : pixelRate > 1280 * 720 * 31 ? "28" : "1f";
      return `avc1.${profile === "high" ? "64" : profile === "main" ? "4d" : "42"}00${level}`;
    }
    case "vp9":
      return big ? "vp09.00.51.08" : "vp09.00.40.08";
    case "av1":
      return big ? "av01.0.12M.08" : "av01.0.08M.08";
  }
}

export function defaultVideoBitrate(codec: VideoCodecName, w: number, h: number, fps: number): number {
  const bitsPerPixel = codec === "avc" ? 0.1 : codec === "vp9" ? 0.075 : 0.06;
  return Math.min(80_000_000, Math.max(1_000_000, Math.round(w * h * fps * bitsPerPixel)));
}

const AUDIO_CODEC_STRING: Record<AudioCodecName, string> = { aac: "mp4a.40.2", opus: "opus" };

/**
 * The encoder config for `codec`. `level` (`ExportSettings.safeLevel`) walks down a ladder of what phone encoders accept: 0 = High profile, variable
 * bitrate, quality latency (best picture); 1 = Main profile, constant bitrate, realtime (what MediaCodec encoders on Android take most reliably);
 * 2 = Baseline and the software encoder (slow but it exists everywhere). Level 3 drops H.264 altogether (see `resolvePreset`).
 */
export function videoConfig(codec: VideoCodecName, plan: ExportPlan, s: ExportSettings, level = 0): VideoEncoderConfig {
  const fps = plan.fpsNum / plan.fpsDen;
  const hardware = s.hardware === "prefer-hardware" ? "prefer-hardware" : s.hardware === "prefer-software" ? "prefer-software" : "no-preference";
  const cfg: VideoEncoderConfig = {
    codec: videoCodecString(codec, plan.width, plan.height, fps, level >= 2 ? "baseline" : level === 1 ? "main" : "high"),
    width: plan.width,
    height: plan.height,
    framerate: fps,
    bitrate: s.videoBitrate ?? defaultVideoBitrate(codec, plan.width, plan.height, fps),
    bitrateMode: level >= 1 ? "constant" : "variable",
    latencyMode: level >= 1 ? "realtime" : "quality",
    hardwareAcceleration: level >= 2 && s.hardware !== "prefer-hardware" ? "prefer-software" : hardware,
  };
  if (codec === "avc") cfg.avc = { format: "avc" };
  return cfg;
}

function audioConfig(codec: AudioCodecName, plan: ExportPlan, s: ExportSettings): AudioEncoderConfig {
  return { codec: AUDIO_CODEC_STRING[codec], sampleRate: plan.sampleRate, numberOfChannels: 2, bitrate: s.audioBitrate ?? (codec === "aac" ? 192_000 : 128_000) };
}

interface Candidate {
  container: "mp4" | "webm";
  video: VideoCodecName;
  audio: AudioCodecName;
  /** Set for the combinations the policy table calls out as limited. */
  warning?: string;
}

/** Preference order for `auto`: ADR 0004, "Recommended default export presets". */
const AUTO_ORDER: Candidate[] = [
  { container: "mp4", video: "avc", audio: "aac" },
  // H.264 wins even without an AAC encoder (Opus audio): the person asked for MP4 by default; the warning says what that costs.
  { container: "mp4", video: "avc", audio: "opus", warning: "This device cannot add AAC audio, so the MP4 has Opus audio. Some phones, TVs and editors may not play it." },
  { container: "webm", video: "vp9", audio: "opus" },
  { container: "mp4", video: "vp9", audio: "opus", warning: "This MP4 uses VP9 and Opus: it plays in browsers but many devices cannot open it." },
  { container: "webm", video: "av1", audio: "opus" },
  { container: "mp4", video: "av1", audio: "opus", warning: "This MP4 uses AV1 and Opus: it plays in recent browsers but many devices cannot open it." },
];

const VIDEO_NAME: Record<string, VideoCodecName> = { h264: "avc", vp9: "vp9", av1: "av1" };
const WEBM_VIDEO: VideoCodecName[] = ["vp9", "av1"];

/**
 * Picks the container and codecs the browser can encode, following the user's choices where given and the ADR 0004 order otherwise.
 * Throws `ExportError("unsupported")` naming what failed; never returns a combination the probe rejected.
 */
export async function resolvePreset(plan: ExportPlan, settings: ExportSettings, probe: CodecProbe): Promise<ResolvedPreset> {
  const level = settings.safeLevel ?? 0;
  const wantC = settings.container ?? "auto";
  const wantV = settings.videoCodec ?? "auto";
  const wantA = settings.audioCodec ?? "auto";
  const candidates = AUTO_ORDER.filter(
    (c) =>
      (wantC === "auto" || c.container === wantC) &&
      (wantV === "auto" || VIDEO_NAME[wantV] === c.video) &&
      (wantA === "auto" || wantA === c.audio) &&
      (c.container !== "webm" || WEBM_VIDEO.includes(c.video)) &&
      // Level 3: H.264 failed three times (some Android encoders): VP9 in WebM, unless the person asked for H.264 by name.
      (level < 3 || c.video !== "avc" || wantV === "h264"),
  );
  const videoOk = new Map<VideoCodecName, boolean>();
  const audioOk = new Map<AudioCodecName, boolean>();
  for (const c of candidates) {
    if (!videoOk.has(c.video)) videoOk.set(c.video, await probe.video(videoConfig(c.video, plan, settings, level)));
    if (!videoOk.get(c.video)) continue;
    if (!audioOk.has(c.audio)) audioOk.set(c.audio, await probe.audio(audioConfig(c.audio, plan, settings)));
    if (!audioOk.get(c.audio)) continue;
    return {
      container: c.container,
      videoCodec: c.video,
      audioCodec: c.audio,
      video: videoConfig(c.video, plan, settings, level),
      audio: audioConfig(c.audio, plan, settings),
      warnings: c.warning ? [c.warning] : [],
    };
  }
  const asked = [wantC, wantV, wantA].filter((x) => x !== "auto").join(" + ") || "any format";
  throw new ExportError("unsupported", `This browser cannot encode ${asked} at ${plan.width}x${plan.height}. Try another format or a smaller size.`);
}

/** One line naming an encoder config, for failure reports: `avc1.640028 1920x1080 4000000bps variable realtime hw:no-preference`. */
export const describeVideoConfig = (c: VideoEncoderConfig): string => `${c.codec} ${c.width}x${c.height} ${c.bitrate}bps ${c.bitrateMode ?? "?"} ${c.latencyMode ?? "?"} hw:${c.hardwareAcceleration ?? "?"}`;
export const describeAudioConfig = (c: AudioEncoderConfig): string => `${c.codec} ${c.sampleRate}Hz x${c.numberOfChannels} ${c.bitrate ?? "?"}bps`;

/** The probe backed by the real WebCodecs `isConfigSupported` (worker or window). */
export const webCodecsProbe: CodecProbe = {
  video: async (c) => {
    try {
      return (await VideoEncoder.isConfigSupported(c)).supported === true;
    } catch {
      return false;
    }
  },
  audio: async (c) => {
    try {
      return (await AudioEncoder.isConfigSupported(c)).supported === true;
    } catch {
      return false;
    }
  },
};
