import { describe, it, expect, afterEach, vi } from "vitest";
import {
  BOOK_EVAPORATION_DEPTH_REMAINING,
  DEFAULT_REJECTION_SETTINGS,
  bandPrice,
  describeRejection,
  deterministicRoll,
  evaluateRejection,
  findStressWindow,
  hashString,
  makeStressWindow,
  mulberry32,
  rejectionKey,
  type RejectionInput,
  type RejectionSettings,
} from "./rejection";

const BAR = Math.floor(Date.UTC(2026, 0, 7, 4, 0, 0) / 1000);

const cfg = (over: Partial<RejectionSettings> = {}): RejectionSettings => ({
  ...DEFAULT_REJECTION_SETTINGS,
  ...over,
});

const order = (over: Partial<RejectionInput> = {}): RejectionInput => ({
  symbol: "BTCUSDT",
  side:   "buy",
  type:   "market",
  qty:    0.01,
  price:  77_000,
  barTime: BAR,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("determinism", () => {
  it("never touches Math.random", () => {
    const spy = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random is banned: backtests must be reproducible");
    });
    for (let i = 0; i < 50; i++) {
      evaluateRejection(order({ qty: 0.001 * (i + 1) }), cfg(), { seed: 7 });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives the same decision for the same order and seed", () => {
    const a = evaluateRejection(order(), cfg(), { seed: 42 });
    const b = evaluateRejection(order(), cfg(), { seed: 42 });
    expect(b).toEqual(a);
  });

  it("changes the draw when the seed changes", () => {
    const a = evaluateRejection(order(), cfg(), { seed: 1 });
    const b = evaluateRejection(order(), cfg(), { seed: 2 });
    expect(a.roll).not.toBe(b.roll);
  });

  it("is independent of evaluation order", () => {
    const orders = Array.from({ length: 100 }, (_, i) =>
      order({ qty: 0.001 * (i + 1), barTime: BAR + i * 60, type: "limit" }));

    const forward = orders.map((o) => evaluateRejection(o, cfg(), { seed: 9 }).roll);
    const backward = [...orders].reverse().map((o) => evaluateRejection(o, cfg(), { seed: 9 }).roll);
    expect(backward.reverse()).toEqual(forward);
  });

  it("produces different draws for different orders", () => {
    const rolls = new Set(
      Array.from({ length: 100 }, (_, i) =>
        evaluateRejection(order({ qty: 0.001 * (i + 1) }), cfg(), { seed: 3 }).roll),
    );
    expect(rolls.size).toBeGreaterThan(90);
  });

  it("an explicit roll overrides the derived one", () => {
    const d = evaluateRejection(order({ type: "limit" }), cfg(), { roll: 0.99 });
    expect(d.roll).toBe(0.99);
  });
});

describe("mulberry32 / hashString / deterministicRoll", () => {
  it("hashString is stable and unsigned", () => {
    expect(hashString("BTCUSDT")).toBe(hashString("BTCUSDT"));
    expect(hashString("BTCUSDT")).toBeGreaterThanOrEqual(0);
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("mulberry32 stays inside [0,1) and repeats for the same seed", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b());
    }
  });

  it("deterministicRoll is stateless — repeated calls give the same value", () => {
    expect(deterministicRoll(1, "k")).toBe(deterministicRoll(1, "k"));
    expect(deterministicRoll(1, "k")).not.toBe(deterministicRoll(1, "k2"));
  });

  it("rejectionKey covers the fields that make an order unique", () => {
    expect(rejectionKey(order())).toBe(`BTCUSDT|${BAR}|buy|market|0.01|77000`);
  });
});

describe("price band — Bybit IOC semantics", () => {
  it("rejects outright when the fill would need more than the tolerated band", () => {
    const d = evaluateRejection(order({ expectedSlippageBps: 80 }), cfg({ slippageToleranceBps: 50 }));
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("price_band");
  });

  it("accepts inside the band", () => {
    const d = evaluateRejection(order({ expectedSlippageBps: 20 }), cfg({ slippageToleranceBps: 50 }), { roll: 0.5 });
    expect(d.accepted).toBe(true);
  });

  it("treats a triggered stop as a taker", () => {
    const d = evaluateRejection(order({ type: "stop", expectedSlippageBps: 80 }), cfg({ slippageToleranceBps: 50 }));
    expect(d.reason).toBe("price_band");
  });

  it("treats a marketable limit as a taker", () => {
    const d = evaluateRejection(
      order({ type: "limit", crossedBook: true, expectedSlippageBps: 80 }),
      cfg({ slippageToleranceBps: 50 }),
    );
    expect(d.reason).toBe("price_band");
  });

  it("bandPrice is the IOC limit the market order becomes", () => {
    expect(bandPrice(100, "buy", 50)).toBeCloseTo(100.5, 10);
    expect(bandPrice(100, "sell", 50)).toBeCloseTo(99.5, 10);
    expect(bandPrice(100, "sell", 1_000_000)).toBe(0);
    expect(bandPrice(0, "buy", 50)).toBe(0);
  });
});

describe("book depth", () => {
  it("rejects when the order is bigger than the visible liquidity", () => {
    const d = evaluateRejection(order({ qty: 5, availableQty: 1 }), cfg());
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("thin_book");
  });

  it("accepts when the book covers the order", () => {
    expect(evaluateRejection(order({ qty: 0.5, availableQty: 1 }), cfg(), { roll: 0.5 }).accepted).toBe(true);
  });

  it("skips the depth check when no liquidity estimate is supplied", () => {
    expect(evaluateRejection(order({ qty: 1_000 }), cfg(), { roll: 0.5 }).accepted).toBe(true);
  });
});

describe("residual miss probability", () => {
  it("misses when the draw lands under the probability", () => {
    const d = evaluateRejection(order(), cfg({ baseRejectProb: 0.01 }), { roll: 0.005 });
    expect(d.reason).toBe("random_miss");
    expect(d.probability).toBeCloseTo(0.01, 10);
  });

  it("fills when the draw is above it", () => {
    expect(evaluateRejection(order(), cfg({ baseRejectProb: 0.01 }), { roll: 0.5 }).accepted).toBe(true);
  });

  it("scales with the bar range: the same draw fills on a calm bar and misses on a wild one", () => {
    const c = cfg({ baseRejectProb: 0.01, volatilityRefPct: 0.2, volatilityMaxFactor: 5, maxRejectProb: 0.03 });
    expect(evaluateRejection(order({ barRangePct: 0.2 }), c, { roll: 0.02 }).accepted).toBe(true);
    const wild = evaluateRejection(order({ barRangePct: 2 }), c, { roll: 0.02 });
    expect(wild.accepted).toBe(false);
    expect(wild.probability).toBeCloseTo(0.03, 10);
  });
});

describe("resting limit queue", () => {
  const c = cfg({ limitFillProbability: 0.6, limitFullFillPenetrationBps: 5 });
  const limit = order({ type: "limit" });

  it("a mere touch fills only with the base probability", () => {
    expect(evaluateRejection(limit, c, { roll: 0.5 }).accepted).toBe(true);
    const miss = evaluateRejection(limit, c, { roll: 0.7 });
    expect(miss.accepted).toBe(false);
    expect(miss.reason).toBe("queue_not_reached");
  });

  it("a deep sweep past the price fills for sure", () => {
    const d = evaluateRejection(order({ type: "limit", penetrationBps: 10 }), c, { roll: 0.999 });
    expect(d.accepted).toBe(true);
  });

  it("partial penetration interpolates the fill probability", () => {
    const d = evaluateRejection(order({ type: "limit", penetrationBps: 2.5 }), c, { roll: 0.85 });
    expect(d.accepted).toBe(false);
    expect(1 - d.probability).toBeCloseTo(0.8, 10);
  });
});

describe("stress window — the book evaporated", () => {
  const window = makeStressWindow(BAR - 600, BAR + 600);
  const c = cfg({ stressWindows: [window] });

  it("carries the 10.10.2025 magnitude by default", () => {
    expect(window.depthRemaining).toBe(BOOK_EVAPORATION_DEPTH_REMAINING);
    expect(window.depthRemaining).toBeLessThan(0.1);
    expect(window.spreadBps).toBeGreaterThan(100);
  });

  it("kills market orders inside the window", () => {
    const d = evaluateRejection(order({ expectedSlippageBps: 5 }), c);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("book_evaporated");
    expect(d.stress).toBe(window);
  });

  it("leaves the same order alone outside the window", () => {
    const d = evaluateRejection(order({ barTime: BAR + 7200, expectedSlippageBps: 5 }), c, { roll: 0.5 });
    expect(d.accepted).toBe(true);
    expect(d.stress).toBeNull();
  });

  it("shrinks the usable depth by more than 90%", () => {
    const wide = cfg({ stressWindows: [makeStressWindow(BAR - 600, BAR + 600, { spreadBps: 0 })] });
    const d = evaluateRejection(order({ qty: 0.5, availableQty: 1 }), wide);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("book_evaporated");
  });

  it("makes resting limits far less likely to fill", () => {
    const wide = cfg({ stressWindows: [makeStressWindow(BAR - 600, BAR + 600, { spreadBps: 0 })] });
    const d = evaluateRejection(order({ type: "limit" }), wide, { roll: 0.3 });
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("book_evaporated");
  });

  it("findStressWindow matches on inclusive bounds", () => {
    expect(findStressWindow(BAR - 600, [window])).toBe(window);
    expect(findStressWindow(BAR + 600, [window])).toBe(window);
    expect(findStressWindow(BAR + 601, [window])).toBeNull();
    expect(findStressWindow(BAR, undefined)).toBeNull();
  });
});

describe("defensive behaviour", () => {
  it("accepts everything when disabled", () => {
    const d = evaluateRejection(order({ expectedSlippageBps: 10_000, qty: 99, availableQty: 0 }), cfg({ enabled: false }));
    expect(d.accepted).toBe(true);
    expect(d.reason).toBe("accepted");
  });

  it("falls back to defaults on an undefined config instead of throwing", () => {
    const d = evaluateRejection(order({ expectedSlippageBps: 500 }), undefined);
    expect(d.accepted).toBe(false);
    expect(d.reason).toBe("price_band");
  });

  it("repairs garbage fields in the config", () => {
    const broken = { ...DEFAULT_REJECTION_SETTINGS, slippageToleranceBps: NaN, volatilityRefPct: 0 } as RejectionSettings;
    const d = evaluateRejection(order({ expectedSlippageBps: 10, barRangePct: 1 }), broken, { roll: 0.9 });
    expect(Number.isFinite(d.probability)).toBe(true);
    expect(d.accepted).toBe(true);
  });

  it("clamps an out-of-range roll override", () => {
    expect(evaluateRejection(order(), cfg(), { roll: 5 }).roll).toBe(1);
    expect(evaluateRejection(order(), cfg(), { roll: -5 }).roll).toBe(0);
  });
});

describe("describeRejection", () => {
  it("summarises the active model", () => {
    const s = describeRejection(cfg({ stressWindows: [makeStressWindow(0, 1)] }));
    expect(s).toContain("band 50 bps");
    expect(s).toContain("1 stress window(s)");
  });

  it("reports off and survives undefined", () => {
    expect(describeRejection(cfg({ enabled: false }))).toBe("off");
    expect(typeof describeRejection(undefined)).toBe("string");
  });
});

describe("custom draw key", () => {
  it("lets neighbouring parameter sets share the same luck", () => {
    const a = evaluateRejection(order({ qty: 0.010, type: "limit" }), cfg(), { seed: 5, key: "bar-1" });
    const b = evaluateRejection(order({ qty: 0.011, type: "limit" }), cfg(), { seed: 5, key: "bar-1" });
    expect(b.roll).toBe(a.roll);
  });

  it("without a key, a different qty gets a different draw", () => {
    const a = evaluateRejection(order({ qty: 0.010, type: "limit" }), cfg(), { seed: 5 });
    const b = evaluateRejection(order({ qty: 0.011, type: "limit" }), cfg(), { seed: 5 });
    expect(b.roll).not.toBe(a.roll);
  });
});
