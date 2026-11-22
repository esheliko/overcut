import type { FromWorker, TestId, TestResult } from "./types";

const PER_TEST_LIMIT_MS = 40_000;

function startWorker(): Worker {
  return new Worker(new URL("./bench.worker.ts", import.meta.url), { type: "module", name: "device-test" });
}

/**
 * Runs one test in a fresh-or-reused Worker. A test that hangs (a stuck hardware decoder, a lost GPU) is stopped after
 * `PER_TEST_LIMIT_MS` and reported as a timeout; the caller then gets a new worker for the next test.
 */
export function createRunner() {
  let worker: Worker | null = null;
  return {
    run(id: TestId, onProgress: (frac: number) => void): Promise<TestResult> {
      return new Promise((resolve) => {
        let done = false;
        const finish = (r: TestResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
        const fail = (status: TestResult["status"], reason: string) => { worker?.terminate(); worker = null; finish({ id, status, reason, metrics: {}, took_ms: PER_TEST_LIMIT_MS }); };
        const timer = setTimeout(() => fail("timeout", "stopped after 40 seconds"), PER_TEST_LIMIT_MS);
        try {
          worker ??= startWorker();
          worker.onmessage = (e: MessageEvent<FromWorker>) => {
            if (e.data.type === "progress") onProgress(e.data.frac);
            else finish(e.data.result);
          };
          worker.onerror = (e) => fail("error", e.message || "the test worker crashed");
          worker.postMessage({ type: "run", id });
        } catch (e) {
          fail("unsupported", e instanceof Error ? e.message : "Web Workers are not available");
        }
      });
    },
    dispose() { worker?.terminate(); worker = null; },
  };
}
