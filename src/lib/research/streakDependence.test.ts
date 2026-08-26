import { describe, it, expect } from "vitest";
import { mulberry32 } from "./random.ts";
import {
  conditionalMeans,
  conditionalWinRates,
  expectedLongestRun,
  maxLossRunNull,
  outcomeSigns,
  permutedConditionalWinRates,
  priorLossRuns,
  probRunAtLeast,
  runsTest,
  shuffled,
  streakLengths,
  wilsonInterval,
} from "./streakDependence.ts";

/** Independent coin flips with win probability p, as returns of +1 / -1. */
function coin(n: number, p: number, seed: number): Float64Array {
  const rng = mulberry32(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() < p ? 1 : -1;
  return out;
}

/**
 * Markov outcomes: after a loss the win chance is `pAfterLoss`, after a win it
 * is `pAfterWin`. The case the proposal claims exists.
 */
function markov(n: number, pAfterWin: number, pAfterLoss: number, seed: number): Float64Array {
  const rng = mulberry32(seed);
  const out = new Float64Array(n);
  let prevWin: boolean = true;
  for (let i = 0; i < n; i++) {
    const pWin: number = prevWin ? pAfterWin : pAfterLoss;
    prevWin = rng() < pWin;
    out[i] = prevWin ? 1 : -1;
  }
  return out;
}

describe("outcome bookkeeping", () => {
  it("treats zero as a loss and maps signs", () => {
    expect(Array.from(outcomeSigns([1, -1, 0, 2]))).toEqual([1, -1, -1, 1]);
  });

  it("counts the run of losses before each index", () => {
    // W L L W L L L
    expect(Array.from(priorLossRuns([1, -1, -1, 1, -1, -1, -1]))).toEqual([0, 0, 1, 2, 0, 1, 2]);
  });

  it("finds the longest runs", () => {
    const s = streakLengths([-1, -1, -1, 1, 1, -1, 1]);
    expect(s.maxLoss).toBe(3);
    expect(s.maxWin).toBe(2);
    expect(s.lossRuns).toBe(2);
  });
});

describe("wilsonInterval", () => {
  it("brackets the point estimate", () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.lo).toBeLessThan(0.5);
    expect(ci.hi).toBeGreaterThan(0.5);
    expect(ci.hi - ci.lo).toBeGreaterThan(0.15);
  });

  it("stays inside [0, 1] at the boundary", () => {
    const ci = wilsonInterval(0, 8);
    expect(ci.lo).toBeGreaterThanOrEqual(0);
    expect(ci.hi).toBeLessThanOrEqual(1);
  });

  it("narrows as n grows", () => {
    const small = wilsonInterval(50, 100);
    const large = wilsonInterval(5000, 10000);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });
});

describe("conditionalWinRates", () => {
  it("finds nothing on independent flips", () => {
    const rets = coin(60000, 0.45, 12345);
    const rows = conditionalWinRates(rets, 5);
    for (const row of rows) {
      expect(Math.abs(row.diff)).toBeLessThan(0.05);
      expect(Math.abs(row.z)).toBeLessThan(3.5);
    }
  });

  it("recovers a real dependence when one is planted", () => {
    const rets = markov(40000, 0.3, 0.7, 999);
    const rows = conditionalWinRates(rets, 3);
    expect(rows[0].winRate).toBeGreaterThan(0.6);
    expect(rows[0].compWinRate).toBeLessThan(0.4);
    expect(rows[0].z).toBeGreaterThan(10);
  });

  it("splits every eligible trade into exactly one of the two cells", () => {
    const rets = coin(500, 0.5, 7);
    for (const row of conditionalWinRates(rets, 4)) {
      expect(row.n + row.compN).toBe(rets.length - row.streak);
    }
  });
});

describe("conditionalMeans", () => {
  it("finds no shift in size on independent draws", () => {
    const rng = mulberry32(4242);
    const rets = new Float64Array(40000);
    for (let i = 0; i < rets.length; i++) rets[i] = rng() < 0.45 ? 2 : -1;
    for (const row of conditionalMeans(rets, 4)) {
      expect(Math.abs(row.t)).toBeLessThan(3.5);
    }
  });

  it("detects a planted shift in the size of the payoff", () => {
    const rng = mulberry32(11);
    const rets = new Float64Array(20000);
    let lossRun = 0;
    for (let i = 0; i < rets.length; i++) {
      const win = rng() < 0.45;
      rets[i] = win ? (lossRun >= 2 ? 8 : 2) : -1;
      lossRun = win ? 0 : lossRun + 1;
    }
    const rows = conditionalMeans(rets, 3);
    expect(rows[2].diff).toBeGreaterThan(1);
    expect(rows[2].t).toBeGreaterThan(5);
  });
});

describe("runsTest", () => {
  it("does not reject on independent flips", () => {
    expect(Math.abs(runsTest(coin(50000, 0.42, 2024)).z)).toBeLessThan(3);
  });

  it("sees too few runs when outcomes cluster", () => {
    const r = runsTest(markov(20000, 0.8, 0.2, 5));
    expect(r.z).toBeLessThan(-20);
    expect(r.runs).toBeLessThan(r.expected);
  });

  it("sees too many runs when outcomes alternate", () => {
    const r = runsTest(markov(20000, 0.2, 0.8, 6));
    expect(r.z).toBeGreaterThan(20);
  });

  it("counts runs the obvious way", () => {
    const r = runsTest([1, 1, -1, -1, -1, 1]);
    expect(r.runs).toBe(3);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(3);
  });
});

describe("probRunAtLeast", () => {
  it("matches the closed form when n equals k", () => {
    expect(probRunAtLeast(5, 5, 0.5)).toBeCloseTo(0.5 ** 5, 12);
  });

  it("is zero when there is no room for the run", () => {
    expect(probRunAtLeast(4, 5, 0.5)).toBe(0);
  });

  it("agrees with a direct enumeration on a short sequence", () => {
    // n = 6, k = 3, p = 0.5 — count the 2^6 sequences containing LLL.
    let hits = 0;
    for (let mask = 0; mask < 64; mask++) {
      let run = 0;
      let found = false;
      for (let i = 0; i < 6; i++) {
        run = (mask >> i) & 1 ? run + 1 : 0;
        if (run >= 3) found = true;
      }
      if (found) hits++;
    }
    expect(probRunAtLeast(6, 3, 0.5)).toBeCloseTo(hits / 64, 12);
  });

  it("agrees with simulation on a long sequence", () => {
    const rng = mulberry32(31337);
    const n = 300;
    const k = 6;
    const p = 0.55;
    let hits = 0;
    const iterations = 20000;
    for (let it = 0; it < iterations; it++) {
      let run = 0;
      let found = false;
      for (let i = 0; i < n; i++) {
        run = rng() < p ? run + 1 : 0;
        if (run >= k) found = true;
      }
      if (found) hits++;
    }
    expect(probRunAtLeast(n, k, p)).toBeCloseTo(hits / iterations, 2);
  });

  it("grows with the number of trials", () => {
    const a = probRunAtLeast(200, 8, 0.55);
    const b = probRunAtLeast(2000, 8, 0.55);
    expect(b).toBeGreaterThan(a);
  });
});

describe("maxLossRunNull", () => {
  it("says a coin's longest run is unremarkable for a coin", () => {
    const rets = coin(3000, 0.45, 77);
    const nullDist = maxLossRunNull(rets, 3000, mulberry32(9));
    expect(nullDist.pAtLeast).toBeGreaterThan(0.05);
    expect(Math.abs(nullDist.observed - nullDist.nullMean)).toBeLessThan(3);
  });

  it("tracks the asymptotic formula", () => {
    const rets = coin(5000, 0.45, 21);
    const nullDist = maxLossRunNull(rets, 2000, mulberry32(3));
    expect(Math.abs(nullDist.nullMean - nullDist.analyticExpected)).toBeLessThan(1);
  });

  it("flags clustered outcomes as an unusually long run", () => {
    const rets = markov(3000, 0.75, 0.25, 12);
    const nullDist = maxLossRunNull(rets, 3000, mulberry32(4));
    expect(nullDist.pAtLeast).toBeLessThan(0.01);
  });
});

describe("expectedLongestRun", () => {
  it("is monotone in n and in p", () => {
    expect(expectedLongestRun(10000, 0.5)).toBeGreaterThan(expectedLongestRun(100, 0.5));
    expect(expectedLongestRun(1000, 0.7)).toBeGreaterThan(expectedLongestRun(1000, 0.5));
  });
});

describe("shuffled", () => {
  it("keeps the multiset and changes the order", () => {
    const src = Float64Array.from({ length: 200 }, (_, i) => i);
    const out = shuffled(src, mulberry32(5));
    expect([...out].sort((a, b) => a - b)).toEqual([...src]);
    expect([...out]).not.toEqual([...src]);
  });
});

describe("permutedConditionalWinRates", () => {
  it("puts an independent series comfortably inside the null band", () => {
    const rets = coin(4000, 0.45, 808);
    const rows = permutedConditionalWinRates(rets, 3, 300, mulberry32(2));
    for (const row of rows) {
      expect(row.p).toBeGreaterThan(0.02);
      expect(row.observed).toBeGreaterThanOrEqual(row.nullLo - 0.15);
      expect(row.observed).toBeLessThanOrEqual(row.nullHi + 0.15);
    }
  });

  it("puts a dependent series outside it", () => {
    const rets = markov(4000, 0.3, 0.7, 606);
    const rows = permutedConditionalWinRates(rets, 2, 300, mulberry32(3));
    expect(rows[0].p).toBeLessThan(0.01);
    expect(rows[0].observed).toBeGreaterThan(rows[0].nullHi);
  });
});
