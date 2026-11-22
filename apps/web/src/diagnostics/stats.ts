/** Small pure helpers shared by the benchmark worker, the report and the unit tests. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export interface Summary { n: number; p50: number; p95: number; max: number }

export function summarize(values: readonly number[]): Summary {
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: values.length, p50: r(percentile(values, 50)), p95: r(percentile(values, 95)), max: r(values.length ? Math.max(...values) : NaN) };
}

/** Deterministic pseudo-random numbers so every device seeks the same frames. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
