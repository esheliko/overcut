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

/** The tests in the order they run. Titles and explanations are in i18n/en.json (`diag.t.<id>.title` / `.what`). */
export const TEST_IDS: TestId[] = ["decode", "seek", "gpuUpload", "fillRate"];
