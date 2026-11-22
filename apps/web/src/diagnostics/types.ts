/** What the page and the benchmark worker say to each other. */
export type TestId = "decode" | "seek" | "gpuUpload" | "fillRate";

export type Verdict = "good" | "ok" | "slow" | "na";

export interface TestResult {
  id: TestId;
  status: "ok" | "unsupported" | "error" | "timeout";
  /** Why it did not run, in words a person can read. */
  reason?: string;
  /** Raw numbers, flat so the copied report stays compact. Milliseconds unless the key says otherwise. */
  metrics: Record<string, number | string>;
  /** Wall time the test took. */
  took_ms: number;
}

export type ToWorker = { type: "run"; id: TestId };
export type FromWorker = { type: "result"; result: TestResult } | { type: "progress"; id: TestId; frac: number };

/** The tests in the order they run, with the plain-language text the page shows. */
export const TESTS: { id: TestId; title: string; what: string }[] = [
  { id: "decode", title: "Playing HD video", what: "How fast your device can unpack full-HD (1080p) video. The faster, the smoother playback and the quicker imports." },
  { id: "seek", title: "Jumping around in a video", what: "How long it takes to show a frame when you drag the playhead to a random spot. Lower is snappier scrubbing." },
  { id: "gpuUpload", title: "Sending frames to the graphics chip", what: "How fast a video frame reaches the graphics chip, the step before any effect is drawn. Direct is the fast route; the others are fallbacks." },
  { id: "fillRate", title: "Drawing layers (effects speed)", what: "How many full-HD layers of effects the graphics chip can draw per frame. More layers means room for titles, overlays and effects." },
];
