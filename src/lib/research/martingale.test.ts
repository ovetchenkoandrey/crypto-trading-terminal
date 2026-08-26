import { describe, it, expect } from "vitest";
import { mulberry32 } from "./random.ts";
import {
  cumulativeStakeMultiple,
  equityAfterLossRun,
  lossRunToRuin,
  riskAfter,
  simulateMartingale,
  toRMultiples,
  type MartingaleConfig,
} from "./martingale.ts";

function cfg(over: Partial<MartingaleConfig> = {}): MartingaleConfig {
  return { baseRisk: 0.02, multiplier: 2, maxSteps: 0, ruinFloor: 0.2, compounding: true, ...over };
}

describe("riskAfter", () => {
  it("doubles per consecutive loss", () => {
    const c = cfg();
    expect(riskAfter(c, 0)).toBeCloseTo(0.02, 12);
    expect(riskAfter(c, 3)).toBeCloseTo(0.16, 12);
  });

  it("stops at the cap", () => {
    const c = cfg({ maxSteps: 2 });
    expect(riskAfter(c, 5)).toBeCloseTo(0.08, 12);
  });

  it("is constant for flat sizing", () => {
    const c = cfg({ multiplier: 1 });
    expect(riskAfter(c, 9)).toBeCloseTo(c.baseRisk, 12);
  });
});

describe("equityAfterLossRun", () => {
  it("matches the hand calculation for two losses", () => {
    const c = cfg({ baseRisk: 0.1, multiplier: 2, compounding: true });
    // 1 -> 0.9 -> 0.9 * (1 - 0.2)
    expect(equityAfterLossRun(c, 2)).toBeCloseTo(0.72, 12);
  });

  it("subtracts a geometric sum when sizing off the starting balance", () => {
    const c = cfg({ baseRisk: 0.01, multiplier: 2, compounding: false });
    expect(equityAfterLossRun(c, 4)).toBeCloseTo(1 - 0.01 * 15, 12);
  });

  it("decays slowly under flat compounding sizing and never reaches zero", () => {
    const c = cfg({ multiplier: 1 });
    expect(equityAfterLossRun(c, 50)).toBeCloseTo(Math.pow(0.98, 50), 10);
    expect(equityAfterLossRun(c, 400)).toBeGreaterThan(0);
  });
});

describe("lossRunToRuin", () => {
  it("kills a doubling scheme in a countable number of trades", () => {
    const k = lossRunToRuin(cfg({ baseRisk: 0.02, multiplier: 2, ruinFloor: 0.2 }));
    expect(k).toBeGreaterThan(4);
    expect(k).toBeLessThan(12);
  });

  it("dies sooner with a bigger base risk", () => {
    expect(lossRunToRuin(cfg({ baseRisk: 0.05 }))).toBeLessThan(lossRunToRuin(cfg({ baseRisk: 0.01 })));
  });

  it("dies sooner with a bigger multiplier", () => {
    expect(lossRunToRuin(cfg({ multiplier: 3 }))).toBeLessThan(lossRunToRuin(cfg({ multiplier: 1.5 })));
  });

  it("survives forever under flat compounding sizing above the floor", () => {
    expect(lossRunToRuin(cfg({ multiplier: 1, ruinFloor: 0 }), 1, 500)).toBe(Number.POSITIVE_INFINITY);
  });

  it("agrees with equityAfterLossRun at the boundary", () => {
    const c = cfg();
    const k = lossRunToRuin(c);
    expect(equityAfterLossRun(c, k)).toBeLessThanOrEqual(c.ruinFloor);
    expect(equityAfterLossRun(c, k - 1)).toBeGreaterThan(c.ruinFloor);
  });
});

describe("cumulativeStakeMultiple", () => {
  it("sums the geometric series", () => {
    expect(cumulativeStakeMultiple(2, 5)).toBeCloseTo(31, 12);
    expect(cumulativeStakeMultiple(1, 5)).toBeCloseTo(5, 12);
  });
});

describe("toRMultiples", () => {
  it("scales by the mean loss so losers sit near -1", () => {
    const { r, unit } = toRMultiples([-10, -30, 40]);
    expect(unit).toBeCloseTo(20, 12);
    expect(r[0]).toBeCloseTo(-0.5, 12);
    expect(r[2]).toBeCloseTo(2, 12);
  });

  it("falls back to a unit scale with no losses at all", () => {
    const { unit } = toRMultiples([1, 2, 3]);
    expect(unit).toBe(1);
  });
});

describe("simulateMartingale", () => {
  /** A negative-expectancy game: 45% chance of +1 R, 55% of -1 R. */
  const negative = Float64Array.from({ length: 1000 }, (_, i) => (i < 450 ? 1 : -1));
  /** A positive-expectancy game: 45% chance of +1.5 R. */
  const positive = Float64Array.from({ length: 1000 }, (_, i) => (i < 450 ? 1.5 : -1));

  it("cannot rescue a negative edge by raising stakes", () => {
    const flat = simulateMartingale(negative, cfg({ multiplier: 1 }), 500, 3000, mulberry32(1));
    const mart = simulateMartingale(negative, cfg({ multiplier: 2 }), 500, 3000, mulberry32(1));
    expect(mart.meanFinal).toBeLessThan(1);
    expect(flat.meanFinal).toBeLessThan(1);
    expect(mart.ruinRate).toBeGreaterThan(flat.ruinRate);
  });

  it("replaces a smooth left tail with an outright wipeout", () => {
    const flat = simulateMartingale(negative, cfg({ multiplier: 1 }), 200, 4000, mulberry32(7));
    const mart = simulateMartingale(negative, cfg({ multiplier: 2 }), 200, 4000, mulberry32(7));
    expect(flat.ruinRate).toBe(0);
    expect(flat.p05).toBeGreaterThan(0.2);
    expect(mart.p05).toBe(0);
    expect(mart.ruinRate).toBeGreaterThan(0.3);
  });

  it("shows the trap: a typical path looks fine while a large minority is dead", () => {
    const mart = simulateMartingale(positive, cfg({ multiplier: 2, baseRisk: 0.005 }), 200, 4000, mulberry32(7));
    expect(mart.medianFinal).toBeGreaterThan(1);
    expect(mart.ruinRate).toBeGreaterThan(0.2);
  });

  it("ruins the account often enough to be the main event", () => {
    const mart = simulateMartingale(negative, cfg({ multiplier: 2, baseRisk: 0.02 }), 1000, 2000, mulberry32(3));
    expect(mart.ruinRate).toBeGreaterThan(0.5);
    expect(mart.medianTradesToRuin).toBeGreaterThan(0);
  });

  it("still ruins a positive-edge strategy when the multiplier is large", () => {
    const safe = simulateMartingale(positive, cfg({ multiplier: 1 }), 1000, 2000, mulberry32(5));
    const risky = simulateMartingale(positive, cfg({ multiplier: 2.5 }), 1000, 2000, mulberry32(5));
    expect(safe.ruinRate).toBeLessThan(0.05);
    expect(risky.ruinRate).toBeGreaterThan(safe.ruinRate);
  });

  it("caps the damage when maxSteps is set", () => {
    const uncapped = simulateMartingale(negative, cfg({ multiplier: 2 }), 500, 2000, mulberry32(11));
    const capped = simulateMartingale(negative, cfg({ multiplier: 2, maxSteps: 2 }), 500, 2000, mulberry32(11));
    expect(capped.ruinRate).toBeLessThan(uncapped.ruinRate);
  });

  it("keeps mean terminal equity below 1 for every scheme once limited liability is off", () => {
    for (const multiplier of [1, 1.5, 2, 3]) {
      const o = simulateMartingale(
        negative,
        { ...cfg({ multiplier }), limitedLiability: false },
        500,
        4000,
        mulberry32(19),
      );
      expect(o.meanFinal).toBeLessThan(1);
    }
  });

  it("shows limited liability inflating the mean while the median stays at zero", () => {
    const c = cfg({ multiplier: 3, baseRisk: 0.02 });
    const forgiven = simulateMartingale(positive, { ...c, limitedLiability: true }, 300, 4000, mulberry32(23));
    const exact = simulateMartingale(positive, { ...c, limitedLiability: false }, 300, 4000, mulberry32(23));
    expect(forgiven.meanFinal).toBeGreaterThan(exact.meanFinal);
    expect(forgiven.medianFinal).toBe(0);
    expect(forgiven.ruinRate).toBeGreaterThan(0.9);
  });

  it("is reproducible for a given seed", () => {
    const a = simulateMartingale(negative, cfg(), 100, 500, mulberry32(42));
    const b = simulateMartingale(negative, cfg(), 100, 500, mulberry32(42));
    expect(a).toEqual(b);
  });

  it("refuses an empty sample rather than returning zeros", () => {
    expect(() => simulateMartingale(new Float64Array(0), cfg(), 10, 10, mulberry32(1))).toThrow();
  });
});
