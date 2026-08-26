import { normalQuantile, normalSf } from "./distributions.ts";

/**
 * Corrections for looking at many slices at once.
 *
 * This study computes several hundred test statistics. At the 5% level, twenty
 * of them are expected to look significant with nothing in the data at all —
 * which is exactly the trap the strategy search is built to avoid, applied one
 * level down.
 */

export interface Labelled {
  label: string;
  p: number;
}

export interface Adjusted extends Labelled {
  /** p * m, capped at 1 — controls the chance of any false positive. */
  bonferroni: number;
  /** Benjamini-Hochberg q-value — controls the expected share of false ones. */
  bh: number;
}

/** Benjamini-Hochberg step-up, plus Bonferroni for the same family. */
export function adjustPValues(tests: readonly Labelled[]): Adjusted[] {
  const m = tests.length;
  const order = tests.map((_, i) => i).sort((a, b) => tests[a].p - tests[b].p);
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const i = order[rank - 1];
    running = Math.min(running, (tests[i].p * m) / rank);
    q[i] = Math.min(1, running);
  }
  return tests.map((t, i) => ({ ...t, bonferroni: Math.min(1, t.p * m), bh: q[i] }));
}

/** Absolute z a single test must clear so the whole family of m holds at alpha. */
export function familywiseZThreshold(m: number, alpha = 0.05): number {
  return normalQuantile(1 - alpha / (2 * m));
}

/**
 * Expected largest absolute z among m independent draws from pure noise, by
 * numerical integration of E[max] = integral of 1 - F(x)^m.
 *
 * This is the number a "best of the grid" result has to beat. A scan of forty
 * parameter sets whose winner shows z = 2.3 has found nothing: noise alone
 * delivers about that much.
 */
export function expectedMaxAbsZ(m: number, upper = 12, steps = 24000): number {
  if (m < 1) return Number.NaN;
  const h = upper / steps;
  let acc = 0;
  for (let i = 0; i <= steps; i++) {
    const x = i * h;
    const f = Math.max(0, 1 - 2 * normalSf(x));
    const term = 1 - Math.pow(f, m);
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    acc += weight * term;
  }
  return (acc * h) / 3;
}
