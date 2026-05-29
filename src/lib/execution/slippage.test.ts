import { describe, it, expect } from "vitest";
import { applySlippage, describeSlippage } from "./slippage";
import type { SlippageSettings } from "../settings";
import type { Ticker } from "../store";

const ticker = (bid: number, ask: number): Ticker => ({
  bid1: bid, ask1: ask,
} as Ticker);

describe("applySlippage", () => {
  describe("none / defensive paths", () => {
    it("returns refPrice when cfg is undefined", () => {
      expect(applySlippage(100, "buy", 1, undefined, undefined)).toBe(100);
    });

    it("returns refPrice when kind=none", () => {
      const cfg: SlippageSettings = { kind: "none", bps: 5, spreadPct: 0.5, impactK: 5, impactRefQty: 1 };
      expect(applySlippage(100, "buy", 1, undefined, cfg)).toBe(100);
    });

    it("returns refPrice when refPrice <= 0", () => {
      const cfg: SlippageSettings = { kind: "fixed_bps", bps: 100, spreadPct: 0, impactK: 0, impactRefQty: 1 };
      expect(applySlippage(0, "buy", 1, undefined, cfg)).toBe(0);
      expect(applySlippage(-5, "buy", 1, undefined, cfg)).toBe(-5);
    });
  });

  describe("fixed_bps", () => {
    const cfg: SlippageSettings = { kind: "fixed_bps", bps: 100, spreadPct: 0, impactK: 0, impactRefQty: 1 };

    it("buy fills above reference (100 bps of 100 = 1)", () => {
      expect(applySlippage(100, "buy", 1, undefined, cfg)).toBeCloseTo(101, 10);
    });

    it("sell fills below reference", () => {
      expect(applySlippage(100, "sell", 1, undefined, cfg)).toBeCloseTo(99, 10);
    });

    it("never returns a negative sell price even with huge bps", () => {
      const huge: SlippageSettings = { ...cfg, bps: 1_000_000 };
      expect(applySlippage(100, "sell", 1, undefined, huge)).toBe(0);
    });

    it("clamps negative bps to zero", () => {
      const neg: SlippageSettings = { ...cfg, bps: -50 };
      expect(applySlippage(100, "buy", 1, undefined, neg)).toBe(100);
    });
  });

  describe("spread_pct", () => {
    const cfg: SlippageSettings = { kind: "spread_pct", bps: 0, spreadPct: 0.5, impactK: 0, impactRefQty: 1 };

    it("returns refPrice when ticker is missing", () => {
      expect(applySlippage(100, "buy", 1, undefined, cfg)).toBe(100);
    });

    it("applies fraction of bid-ask spread (bid=99,ask=101 → 200 bps spread, 50% = 100 bps = +1)", () => {
      expect(applySlippage(100, "buy", 1, ticker(99, 101), cfg)).toBeCloseTo(101, 10);
      expect(applySlippage(100, "sell", 1, ticker(99, 101), cfg)).toBeCloseTo(99, 10);
    });

    it("clamps spreadPct into [0, 1]", () => {
      const over: SlippageSettings = { ...cfg, spreadPct: 5 };
      // Effectively 100% of 200 bps = 200 bps → delta=2
      expect(applySlippage(100, "buy", 1, ticker(99, 101), over)).toBeCloseTo(102, 10);
    });
  });

  describe("volume_impact", () => {
    const cfg: SlippageSettings = { kind: "volume_impact", bps: 0, spreadPct: 0, impactK: 5, impactRefQty: 1 };

    it("scales as k * sqrt(qty / refQty)", () => {
      // k=5, qty=4, ref=1 → sqrt(4)=2 → bps=10 → on 100 → delta=0.1
      expect(applySlippage(100, "buy", 4, undefined, cfg)).toBeCloseTo(100.1, 10);
      expect(applySlippage(100, "sell", 4, undefined, cfg)).toBeCloseTo(99.9, 10);
    });

    it("qty=0 → no slippage", () => {
      expect(applySlippage(100, "buy", 0, undefined, cfg)).toBe(100);
    });

    it("guards against impactRefQty=0 (no NaN/Infinity)", () => {
      const zero: SlippageSettings = { ...cfg, impactRefQty: 0 };
      const out = applySlippage(100, "buy", 1, undefined, zero);
      expect(Number.isFinite(out)).toBe(true);
    });
  });
});

describe("describeSlippage", () => {
  it("formats each kind", () => {
    expect(describeSlippage({ kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 })).toBe("off");
    expect(describeSlippage({ kind: "fixed_bps", bps: 7, spreadPct: 0, impactK: 0, impactRefQty: 1 })).toBe("7 bps");
    expect(describeSlippage({ kind: "spread_pct", bps: 0, spreadPct: 0.25, impactK: 0, impactRefQty: 1 })).toBe("25% spread");
    expect(describeSlippage({ kind: "volume_impact", bps: 0, spreadPct: 0, impactK: 3, impactRefQty: 2 })).toBe("k=3 / ref=2");
  });
});
