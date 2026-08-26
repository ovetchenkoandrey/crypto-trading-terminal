import { describe, expect, it } from "vitest";
import { autocorrAt, autocorrProfile, ljungBox, neweyWestSE, reversalByMagnitude, signEdge } from "./autocorr.ts";
import { ar1Series, garchSeries, mulberry32, normalSeries } from "./random.ts";

describe("autocorrAt", () => {
  it("recovers the coefficient of an AR(1)", () => {
    const x = ar1Series(200000, 0.3, 0.001, mulberry32(21));
    const r1 = autocorrAt([x], 1);
    // Sampling error at n = 2e5 is about 0.002, so 0.01 is a few sigma wide.
    expect(Math.abs(r1.rho - 0.3)).toBeLessThan(0.01);
    // AR(1) decays geometrically: rho_2 = phi^2.
    expect(Math.abs(autocorrAt([x], 2).rho - 0.09)).toBeLessThan(0.01);
    expect(Math.abs(r1.z)).toBeGreaterThan(10);
  });

  it("finds nothing in white noise", () => {
    const x = normalSeries(200000, 0.001, mulberry32(22));
    for (const lag of [1, 2, 5]) expect(Math.abs(autocorrAt([x], lag).z)).toBeLessThan(4);
  });

  it("is one at lag zero", () => {
    const x = normalSeries(5000, 1, mulberry32(23));
    expect(autocorrAt([x], 0).rho).toBeCloseTo(1, 10);
  });

  it("never pairs across a block boundary", () => {
    // Two blocks that would show a large lag-1 correlation only if the seam
    // between them were treated as a real step.
    const a = Float64Array.from([1, 1, 1, 1]);
    const b = Float64Array.from([-1, -1, -1, -1]);
    const joined = autocorrAt([Float64Array.from([...a, ...b])], 1);
    const split = autocorrAt([a, b], 1);
    expect(joined.pairs).toBe(7);
    expect(split.pairs).toBe(6);
    expect(split.rho).toBeGreaterThan(joined.rho);
  });

  it("robust and iid standard errors agree for homoskedastic noise", () => {
    const x = normalSeries(100000, 0.001, mulberry32(24));
    const r = autocorrAt([x], 1);
    expect(r.seRobust / r.seIid).toBeGreaterThan(0.85);
    expect(r.seRobust / r.seIid).toBeLessThan(1.15);
  });

  it("robust standard error is the wider one under volatility clustering", () => {
    const x = garchSeries(200000, 0.12, 0.85, 0.001, mulberry32(25));
    const r = autocorrAt([x], 1);
    expect(r.seRobust).toBeGreaterThan(r.seIid * 1.2);
  });
});

describe("autocorrProfile", () => {
  it("returns one row per requested lag, in order", () => {
    const x = normalSeries(5000, 1, mulberry32(26));
    const rows = autocorrProfile([x], [1, 3, 10]);
    expect(rows.map((r) => r.lag)).toEqual([1, 3, 10]);
  });
});

describe("ljungBox", () => {
  it("rejects for an AR(1) and does not for noise", () => {
    const ar = ar1Series(50000, 0.2, 0.001, mulberry32(27));
    const noise = normalSeries(50000, 0.001, mulberry32(28));
    expect(ljungBox([ar], 10).pRobust).toBeLessThan(1e-6);
    expect(ljungBox([noise], 10).pRobust).toBeGreaterThan(0.01);
  });

  it("the classical statistic over-rejects where the robust one does not", () => {
    const x = garchSeries(200000, 0.12, 0.85, 0.001, mulberry32(29));
    const lb = ljungBox([x], 20);
    expect(lb.qRobust).toBeLessThan(lb.q);
  });
});

describe("neweyWestSE", () => {
  it("equals the plain standard error at bandwidth zero", () => {
    const x = normalSeries(10000, 1, mulberry32(30));
    let sum = 0;
    for (const v of x) sum += v;
    const m = sum / x.length;
    let ss = 0;
    for (const v of x) ss += (v - m) * (v - m);
    // Population divisor n, matching the gamma_0 the estimator uses.
    const plain = Math.sqrt(ss / x.length / x.length);
    expect(neweyWestSE(x, 0)).toBeCloseTo(plain, 12);
  });

  it("widens when neighbouring observations are positively related", () => {
    const x = ar1Series(20000, 0.5, 1, mulberry32(31));
    expect(neweyWestSE(x, 10)).toBeGreaterThan(neweyWestSE(x, 0) * 1.3);
  });
});

describe("signEdge", () => {
  it("turns positive autocorrelation into a positive gross edge", () => {
    const x = ar1Series(200000, 0.2, 0.001, mulberry32(32));
    const edge = signEdge([x], 1);
    expect(edge.edgeBps).toBeGreaterThan(0);
    expect(edge.t).toBeGreaterThan(5);
    expect(edge.hitRate).toBeGreaterThan(0.5);
  });

  it("flips sign in contrarian mode", () => {
    const x = ar1Series(200000, 0.2, 0.001, mulberry32(33));
    expect(signEdge([x], 1, true).edgeBps).toBeCloseTo(-signEdge([x], 1).edgeBps, 6);
  });

  it("finds no edge in white noise", () => {
    const x = normalSeries(200000, 0.001, mulberry32(34));
    expect(Math.abs(signEdge([x], 1).t)).toBeLessThan(3);
  });

  it("scales roughly as rho * sigma * sqrt(2/pi)", () => {
    const phi = 0.25;
    const sigma = 0.001;
    const x = ar1Series(400000, phi, sigma, mulberry32(35));
    const observed = signEdge([x], 1).edgeBps;
    // Stationary standard deviation of an AR(1) is sigma / sqrt(1 - phi^2).
    const sd = sigma / Math.sqrt(1 - phi * phi);
    const expected = phi * sd * Math.sqrt(2 / Math.PI) * 1e4;
    expect(observed).toBeGreaterThan(expected * 0.8);
    expect(observed).toBeLessThan(expected * 1.2);
  });
});

describe("reversalByMagnitude", () => {
  it("splits the sample into equal buckets ordered by trigger size", () => {
    const x = normalSeries(100000, 0.001, mulberry32(36));
    const buckets = reversalByMagnitude([x], 10);
    expect(buckets.length).toBe(10);
    const total = buckets.reduce((a, b) => a + b.n, 0);
    expect(total).toBe(99999);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].meanTriggerBps).toBeGreaterThan(buckets[i - 1].meanTriggerBps);
    }
  });

  it("finds no reversal anywhere in white noise", () => {
    const x = normalSeries(200000, 0.001, mulberry32(37));
    for (const b of reversalByMagnitude([x], 5)) expect(Math.abs(b.t)).toBeLessThan(4);
  });

  it("finds reversal in every bucket when the whole series reverts", () => {
    const x = ar1Series(200000, -0.25, 0.001, mulberry32(38));
    const buckets = reversalByMagnitude([x], 5);
    for (const b of buckets) expect(b.reversalBps).toBeGreaterThan(0);
    // Fading a big move pays more than fading a small one, in absolute terms.
    expect(buckets[4].reversalBps).toBeGreaterThan(buckets[0].reversalBps);
  });

  it("isolates reversal that lives only in the largest moves", () => {
    // Independent bars, except that a bar past three sigma is followed by a
    // partial snap back. A single correlation coefficient would smear this.
    const rng = mulberry32(39);
    const x = normalSeries(200000, 0.001, rng);
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i - 1]) > 0.003) x[i] -= 0.4 * x[i - 1];
    const buckets = reversalByMagnitude([x], 10);
    expect(Math.abs(buckets[0].t)).toBeLessThan(4);
    expect(buckets[9].t).toBeGreaterThan(5);
    expect(buckets[9].reversalBps).toBeGreaterThan(buckets[0].reversalBps * 5);
  });

  it("reports the fade hit rate", () => {
    const x = ar1Series(100000, -0.3, 0.001, mulberry32(40));
    expect(reversalByMagnitude([x], 2)[1].hitRate).toBeGreaterThan(0.5);
  });
});
