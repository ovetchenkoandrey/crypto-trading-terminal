/**
 * Does the outcome of a trade depend on the outcomes before it?
 *
 * The martingale proposal on the table is: watch the signals, wait for a long
 * run of losers, then enter with size because "the odds have swung". That is
 * either a real edge or the gambler's fallacy, and which one it is is a
 * measurable property of the trade sequence — not a matter of opinion.
 *
 * Three independent readings of the same question live here:
 *
 *  1. autocorrelation of the outcome signs (delegated to `autocorr.ts`, which
 *     already carries heteroskedasticity-consistent standard errors);
 *  2. P(win | the previous N trades all lost) against the win rate of the very
 *     same trades when they are *not* preceded by such a run;
 *  3. the Wald-Wolfowitz runs test, which asks whether the whole streak
 *     structure differs from a coin with the same bias.
 *
 * Every conditional statistic here is also fed through a permutation null: the
 * same trades, shuffled. Shuffling destroys order and keeps the multiset, so it
 * is exactly the null "outcomes are independent, the win rate is what it is".
 * Analytic standard errors on conditional-on-a-run statistics are awkward
 * (overlapping conditions, small cells); the permutation is not.
 */

import { welchTest } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";
import type { Rng } from "./random.ts";

/** A trade is a win when it made money. Zero counts as a loss: it did not. */
export function isWin(ret: number): boolean {
  return ret > 0;
}

/** +1 for a win, -1 for anything else. Zeros are reported separately. */
export function outcomeSigns(rets: ArrayLike<number>): Float64Array {
  const out = new Float64Array(rets.length);
  for (let i = 0; i < rets.length; i++) out[i] = isWin(rets[i]) ? 1 : -1;
  return out;
}

/** Wilson score interval — honest at the small counts that deep streaks give. */
export function wilsonInterval(wins: number, n: number, z = 1.959963985): { lo: number; hi: number } {
  if (n <= 0) return { lo: Number.NaN, hi: Number.NaN };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: (centre - half) / denom, hi: (centre + half) / denom };
}

/** Length of the run of losses immediately before index i. */
export function priorLossRun(rets: ArrayLike<number>, i: number): number {
  let k = 0;
  for (let j = i - 1; j >= 0 && !isWin(rets[j]); j--) k++;
  return k;
}

/** Prior-loss-run length for every index, in one pass. */
export function priorLossRuns(rets: ArrayLike<number>): Int32Array {
  const out = new Int32Array(rets.length);
  let run = 0;
  for (let i = 0; i < rets.length; i++) {
    out[i] = run;
    run = isWin(rets[i]) ? 0 : run + 1;
  }
  return out;
}

export interface StreakCondition {
  /** N: the number of consecutive losses that must precede the trade. */
  streak: number;
  n: number;
  wins: number;
  winRate: number;
  ciLo: number;
  ciHi: number;
  /** Trades eligible at this N that are *not* preceded by such a run. */
  compN: number;
  compWins: number;
  compWinRate: number;
  /** Conditional minus comparison. */
  diff: number;
  /** Two-proportion z. NaN when either cell is empty. */
  z: number;
  p: number;
}

/**
 * P(win | at least N preceding losses) versus P(win | fewer than N).
 *
 * The comparison group is restricted to trades with index >= N so that both
 * sides are drawn from the same stretch of the sequence; comparing a
 * conditional cell against the unconditional rate would double-count the cell
 * itself and shrink the difference toward zero.
 */
export function conditionalWinRates(rets: ArrayLike<number>, maxStreak = 10): StreakCondition[] {
  const runs = priorLossRuns(rets);
  const out: StreakCondition[] = [];
  for (let s = 1; s <= maxStreak; s++) {
    let n = 0;
    let wins = 0;
    let compN = 0;
    let compWins = 0;
    for (let i = s; i < rets.length; i++) {
      const win = isWin(rets[i]) ? 1 : 0;
      if (runs[i] >= s) {
        n++;
        wins += win;
      } else {
        compN++;
        compWins += win;
      }
    }
    const p1 = n > 0 ? wins / n : Number.NaN;
    const p2 = compN > 0 ? compWins / compN : Number.NaN;
    const ci = wilsonInterval(wins, n);
    let z = Number.NaN;
    if (n > 0 && compN > 0) {
      const pooled = (wins + compWins) / (n + compN);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / compN));
      z = se > 0 ? (p1 - p2) / se : Number.NaN;
    }
    out.push({
      streak: s,
      n,
      wins,
      winRate: p1,
      ciLo: ci.lo,
      ciHi: ci.hi,
      compN,
      compWins,
      compWinRate: p2,
      diff: p1 - p2,
      z,
      p: twoSidedP(z),
    });
  }
  return out;
}

export interface StreakMean {
  streak: number;
  n: number;
  /** Mean per-trade return of trades preceded by at least N losses. */
  meanRet: number;
  se: number;
  compN: number;
  compMean: number;
  diff: number;
  /** Welch t for the difference of means. */
  t: number;
  p: number;
}

/**
 * The half of the question a win rate cannot answer. A scheme can keep the same
 * hit rate and still pay, if the winners after a drought are bigger. This
 * measures that directly, in whatever unit the returns came in.
 */
export function conditionalMeans(rets: ArrayLike<number>, maxStreak = 10): StreakMean[] {
  const runs = priorLossRuns(rets);
  const out: StreakMean[] = [];
  for (let s = 1; s <= maxStreak; s++) {
    const hit: number[] = [];
    const miss: number[] = [];
    for (let i = s; i < rets.length; i++) {
      (runs[i] >= s ? hit : miss).push(rets[i]);
    }
    const w = welchTest(hit, miss);
    let se = Number.NaN;
    if (hit.length > 1) {
      const m = hit.reduce((a, b) => a + b, 0) / hit.length;
      let v = 0;
      for (const x of hit) v += (x - m) * (x - m);
      se = Math.sqrt(v / (hit.length - 1) / hit.length);
    }
    const meanHit = hit.length ? hit.reduce((a, b) => a + b, 0) / hit.length : Number.NaN;
    const meanMiss = miss.length ? miss.reduce((a, b) => a + b, 0) / miss.length : Number.NaN;
    out.push({
      streak: s,
      n: hit.length,
      meanRet: meanHit,
      se,
      compN: miss.length,
      compMean: meanMiss,
      diff: meanHit - meanMiss,
      t: w.t,
      p: twoSidedP(w.t),
    });
  }
  return out;
}

/* ── runs test ────────────────────────────────────────────────────────────── */

export interface RunsTest {
  n: number;
  wins: number;
  losses: number;
  /** Observed number of maximal same-sign blocks. */
  runs: number;
  expected: number;
  sd: number;
  z: number;
  p: number;
}

/**
 * Wald-Wolfowitz. Fewer runs than expected means outcomes cluster (streaks are
 * longer than a coin would give — the case that would support the proposal);
 * more runs means they alternate. The normal approximation is used, which is
 * fine well past a hundred trades.
 */
export function runsTest(rets: ArrayLike<number>): RunsTest {
  const n = rets.length;
  let wins = 0;
  let runs = 0;
  let prev: boolean | null = null;
  for (let i = 0; i < n; i++) {
    const w = isWin(rets[i]);
    if (w) wins++;
    if (prev === null || w !== prev) runs++;
    prev = w;
  }
  const losses = n - wins;
  if (wins === 0 || losses === 0) {
    return { n, wins, losses, runs, expected: Number.NaN, sd: Number.NaN, z: Number.NaN, p: Number.NaN };
  }
  const expected = (2 * wins * losses) / n + 1;
  const varRuns = (2 * wins * losses * (2 * wins * losses - n)) / (n * n * (n - 1));
  const sd = Math.sqrt(varRuns);
  const z = sd > 0 ? (runs - expected) / sd : Number.NaN;
  return { n, wins, losses, runs, expected, sd, z, p: twoSidedP(z) };
}

/* ── streak lengths ───────────────────────────────────────────────────────── */

export interface StreakLengths {
  maxLoss: number;
  maxWin: number;
  lossRuns: number;
  meanLossRun: number;
}

export function streakLengths(rets: ArrayLike<number>): StreakLengths {
  let maxLoss = 0;
  let maxWin = 0;
  let loss = 0;
  let win = 0;
  let lossRuns = 0;
  let lossTotal = 0;
  for (let i = 0; i < rets.length; i++) {
    if (isWin(rets[i])) {
      if (loss > 0) {
        lossRuns++;
        lossTotal += loss;
      }
      loss = 0;
      win++;
      if (win > maxWin) maxWin = win;
    } else {
      win = 0;
      loss++;
      if (loss > maxLoss) maxLoss = loss;
    }
  }
  if (loss > 0) {
    lossRuns++;
    lossTotal += loss;
  }
  return { maxLoss, maxWin, lossRuns, meanLossRun: lossRuns ? lossTotal / lossRuns : 0 };
}

/* ── permutation and simulation nulls ─────────────────────────────────────── */

export function shuffled(src: ArrayLike<number>, rng: Rng): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

export interface PermutedStat {
  streak: number;
  observed: number;
  n: number;
  nullMean: number;
  nullLo: number;
  nullHi: number;
  /** Share of shuffles at least as far from the null mean as the observation. */
  p: number;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function summarise(observed: number, n: number, streak: number, draws: number[]): PermutedStat {
  const usable = draws.filter((d) => Number.isFinite(d));
  usable.sort((a, b) => a - b);
  const m = usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : Number.NaN;
  let extreme = 0;
  if (Number.isFinite(observed)) {
    const d = Math.abs(observed - m);
    for (const x of usable) if (Math.abs(x - m) >= d) extreme++;
  }
  return {
    streak,
    observed,
    n,
    nullMean: m,
    nullLo: percentile(usable, 0.025),
    nullHi: percentile(usable, 0.975),
    p: usable.length ? (extreme + 1) / (usable.length + 1) : Number.NaN,
  };
}

/**
 * Permutation null for the conditional win rates. Reshuffling the trade
 * sequence keeps the win rate and the payoff distribution and removes only the
 * order — so the spread of these draws is precisely how much a conditional
 * cell wanders when nothing at all is going on.
 */
export function permutedConditionalWinRates(
  rets: ArrayLike<number>,
  maxStreak: number,
  iterations: number,
  rng: Rng,
): PermutedStat[] {
  const observed = conditionalWinRates(rets, maxStreak);
  const draws: number[][] = Array.from({ length: maxStreak }, () => []);
  for (let it = 0; it < iterations; it++) {
    const perm = conditionalWinRates(shuffled(rets, rng), maxStreak);
    for (let s = 0; s < maxStreak; s++) draws[s].push(perm[s].winRate);
  }
  return observed.map((o, s) => summarise(o.winRate, o.n, o.streak, draws[s]));
}

/** Same idea for the mean return conditional on a preceding run of losses. */
export function permutedConditionalMeans(
  rets: ArrayLike<number>,
  maxStreak: number,
  iterations: number,
  rng: Rng,
): PermutedStat[] {
  const observed = conditionalMeans(rets, maxStreak);
  const draws: number[][] = Array.from({ length: maxStreak }, () => []);
  for (let it = 0; it < iterations; it++) {
    const perm = conditionalMeans(shuffled(rets, rng), maxStreak);
    for (let s = 0; s < maxStreak; s++) draws[s].push(perm[s].meanRet);
  }
  return observed.map((o, s) => summarise(o.meanRet, o.n, o.streak, draws[s]));
}

export interface MaxRunNull {
  observed: number;
  n: number;
  lossRate: number;
  iterations: number;
  nullMean: number;
  nullMedian: number;
  nullP95: number;
  nullMax: number;
  /** Share of independent sequences whose longest losing run is >= observed. */
  pAtLeast: number;
  /** Closed-form expectation of the longest run, for a sanity check. */
  analyticExpected: number;
}

/** Longest run of losses in `n` independent trials with loss probability `p`. */
export function simulateMaxLossRun(n: number, p: number, iterations: number, rng: Rng): number[] {
  const out: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let run = 0;
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (rng() < p) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    out.push(best);
  }
  return out;
}

/** Erdos-Renyi asymptotic for the longest run of an event with probability p. */
export function expectedLongestRun(n: number, p: number): number {
  if (!(p > 0 && p < 1) || n < 1) return Number.NaN;
  const base = Math.log(1 / p);
  const gamma = 0.5772156649015329;
  return Math.log(n * (1 - p)) / base + gamma / base - 0.5;
}

export function maxLossRunNull(rets: ArrayLike<number>, iterations: number, rng: Rng): MaxRunNull {
  const n = rets.length;
  let wins = 0;
  for (let i = 0; i < n; i++) if (isWin(rets[i])) wins++;
  const lossRate = n ? (n - wins) / n : Number.NaN;
  const observed = streakLengths(rets).maxLoss;
  const draws = simulateMaxLossRun(n, lossRate, iterations, rng);
  const sorted = [...draws].sort((a, b) => a - b);
  let atLeast = 0;
  for (const d of draws) if (d >= observed) atLeast++;
  return {
    observed,
    n,
    lossRate,
    iterations,
    nullMean: draws.reduce((a, b) => a + b, 0) / draws.length,
    nullMedian: percentile(sorted, 0.5),
    nullP95: percentile(sorted, 0.95),
    nullMax: sorted[sorted.length - 1],
    pAtLeast: (atLeast + 1) / (draws.length + 1),
    analyticExpected: expectedLongestRun(n, lossRate),
  };
}

/**
 * Exact probability that `n` independent trials contain a run of at least `k`
 * losses, each with probability `p`.
 *
 * Recursion on A(i) = P(no such run in the first i trials):
 *   A(i) = A(i-1) - (1-p) * p^k * A(i-k-1).
 * Exact, not simulated — this number is the one that decides how long a
 * martingale survives, and a Monte Carlo estimate of a 1e-4 event is useless.
 */
export function probRunAtLeast(n: number, k: number, p: number): number {
  if (k <= 0) return 1;
  if (n < k) return 0;
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  const a = new Float64Array(n + 1);
  for (let i = 0; i < k; i++) a[i] = 1;
  a[k] = 1 - Math.pow(p, k);
  const step = (1 - p) * Math.pow(p, k);
  for (let i = k + 1; i <= n; i++) {
    a[i] = a[i - 1] - step * a[i - k - 1];
  }
  return Math.min(1, Math.max(0, 1 - a[n]));
}
