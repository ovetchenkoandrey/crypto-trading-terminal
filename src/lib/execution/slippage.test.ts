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

/* ── context multipliers ──────────────────────────────────────────────────── */

import {
  DEFAULT_SLIPPAGE_CONTEXT,
  applySlippageWithContext,
  describeSlippageContext,
  isWeekendBar,
  slippageMultiplier,
  timeOfDayMultiplier,
  utcDayOfWeekOfBar,
  utcHourOfBar,
  volatilityMultiplier,
  type SlippageContextSettings,
} from "./slippage";

const sec = (ms: number) => Math.floor(ms / 1000);

// 2026-01-01 is a Thursday, so Jan 3 is a Saturday and Jan 7 a Wednesday.
const WED_04 = sec(Date.UTC(2026, 0, 7, 4, 0, 0));
const WED_12 = sec(Date.UTC(2026, 0, 7, 12, 0, 0));
const WED_22 = sec(Date.UTC(2026, 0, 7, 22, 0, 0));
const SAT_12 = sec(Date.UTC(2026, 0, 3, 12, 0, 0));
const SAT_04 = sec(Date.UTC(2026, 0, 3, 4, 0, 0));

const ctxCfg = (over: Partial<SlippageContextSettings> = {}): SlippageContextSettings => ({
  ...DEFAULT_SLIPPAGE_CONTEXT,
  ...over,
});

describe("utcHourOfBar", () => {
  it("takes the hour from the bar, matching the UTC calendar", () => {
    expect(utcHourOfBar(WED_04)).toBe(4);
    expect(utcHourOfBar(WED_12)).toBe(12);
    expect(utcHourOfBar(WED_22)).toBe(22);
  });

  it("agrees with Date.getUTCHours for a sample of times", () => {
    for (const h of [0, 3, 5, 11, 17, 23]) {
      const ms = Date.UTC(2026, 5, 15, h, 30, 0);
      expect(utcHourOfBar(sec(ms))).toBe(new Date(ms).getUTCHours());
    }
  });

  it("tolerates a millisecond timestamp instead of failing silently", () => {
    const ms = Date.UTC(2026, 0, 7, 4, 0, 0);
    expect(utcHourOfBar(ms)).toBe(4);
  });

  it("returns NaN for garbage", () => {
    expect(Number.isNaN(utcHourOfBar(NaN))).toBe(true);
  });
});

describe("utcDayOfWeekOfBar / isWeekendBar", () => {
  it("agrees with Date.getUTCDay", () => {
    for (const d of [1, 2, 3, 4, 5, 6, 7]) {
      const ms = Date.UTC(2026, 0, d, 9, 0, 0);
      expect(utcDayOfWeekOfBar(sec(ms))).toBe(new Date(ms).getUTCDay());
    }
  });

  it("flags Saturday and Sunday only", () => {
    expect(isWeekendBar(SAT_12)).toBe(true);
    expect(isWeekendBar(sec(Date.UTC(2026, 0, 4, 12, 0, 0)))).toBe(true);
    expect(isWeekendBar(WED_12)).toBe(false);
  });
});

describe("timeOfDayMultiplier", () => {
  it("is 1 in a normal weekday hour", () => {
    expect(timeOfDayMultiplier(WED_12)).toBe(1);
  });

  it("raises slippage in the 03:00-06:00 UTC trough", () => {
    expect(timeOfDayMultiplier(WED_04)).toBeCloseTo(1.75, 10);
  });

  it("raises slippage in the 21:00-23:00 UTC window", () => {
    expect(timeOfDayMultiplier(WED_22)).toBeCloseTo(1.75, 10);
  });

  it("doubles on the weekend", () => {
    expect(timeOfDayMultiplier(SAT_12)).toBeCloseTo(2, 10);
  });

  it("compounds weekend and dead hour, capped by maxMultiplier", () => {
    expect(timeOfDayMultiplier(SAT_04)).toBeCloseTo(3.5, 10);
    expect(timeOfDayMultiplier(SAT_04, ctxCfg({ maxMultiplier: 3 }))).toBeCloseTo(3, 10);
  });

  it("is 1 when disabled", () => {
    expect(timeOfDayMultiplier(SAT_04, ctxCfg({ enabled: false }))).toBe(1);
  });

  it("never discounts below 1 even with a silly config", () => {
    expect(timeOfDayMultiplier(WED_04, ctxCfg({ deadHourMultiplier: 0.1 }))).toBe(1);
  });

  it("honours a custom dead-hour list", () => {
    expect(timeOfDayMultiplier(WED_12, ctxCfg({ deadHoursUtc: [12] }))).toBeCloseTo(1.75, 10);
  });
});

describe("volatilityMultiplier", () => {
  it("is 1 on a bar at the reference range", () => {
    expect(volatilityMultiplier({ high: 100.2, low: 100, close: 100 })).toBeCloseTo(1, 6);
  });

  it("scales with the bar range", () => {
    expect(volatilityMultiplier({ high: 100.4, low: 100, close: 100 })).toBeCloseTo(2, 6);
  });

  it("never discounts a calm bar", () => {
    expect(volatilityMultiplier({ high: 100.01, low: 100, close: 100 })).toBe(1);
  });

  it("caps at volatilityMaxMultiplier", () => {
    expect(volatilityMultiplier({ high: 110, low: 100, close: 100 })).toBe(3);
  });

  it("is 1 without a bar, when disabled, or on nonsense values", () => {
    expect(volatilityMultiplier(undefined)).toBe(1);
    expect(volatilityMultiplier({ high: 101, low: 100, close: 100 }, ctxCfg({ volatilityEnabled: false }))).toBe(1);
    expect(volatilityMultiplier({ high: NaN, low: 100, close: 100 })).toBe(1);
    expect(volatilityMultiplier({ high: 101, low: 100, close: 0 })).toBe(1);
  });
});

describe("slippageMultiplier", () => {
  it("multiplies the time and volatility components", () => {
    const m = slippageMultiplier({ barTime: WED_04, bar: { high: 100.4, low: 100, close: 100 } });
    expect(m).toBeCloseTo(3.5, 6);
  });

  it("respects the overall cap", () => {
    const m = slippageMultiplier({ barTime: SAT_04, bar: { high: 110, low: 100, close: 100 } });
    expect(m).toBe(DEFAULT_SLIPPAGE_CONTEXT.maxMultiplier);
  });

  it("is 1 when the context model is off", () => {
    const m = slippageMultiplier({ barTime: SAT_04, contextCfg: ctxCfg({ enabled: false }) });
    expect(m).toBe(1);
  });
});

describe("applySlippageWithContext", () => {
  const base: SlippageSettings = { kind: "fixed_bps", bps: 100, spreadPct: 0, impactK: 0, impactRefQty: 1 };

  it("matches applySlippage in a normal weekday hour", () => {
    const out = applySlippageWithContext(100, "buy", 1, undefined, base, { barTime: WED_12 });
    expect(out).toBeCloseTo(applySlippage(100, "buy", 1, undefined, base), 10);
  });

  it("scales the delta, not the price, in a dead hour", () => {
    expect(applySlippageWithContext(100, "buy", 1, undefined, base, { barTime: WED_04 }))
      .toBeCloseTo(101.75, 10);
    expect(applySlippageWithContext(100, "sell", 1, undefined, base, { barTime: WED_04 }))
      .toBeCloseTo(98.25, 10);
  });

  it("reads the context config off the slippage settings when present", () => {
    const withCtx: SlippageSettings = { ...base, context: ctxCfg({ deadHourMultiplier: 3 }) };
    expect(applySlippageWithContext(100, "buy", 1, undefined, withCtx, { barTime: WED_04 }))
      .toBeCloseTo(103, 10);
  });

  it("lets the caller override the context config per call", () => {
    const withCtx: SlippageSettings = { ...base, context: ctxCfg({ deadHourMultiplier: 3 }) };
    const out = applySlippageWithContext(100, "buy", 1, undefined, withCtx, {
      barTime: WED_04, contextCfg: ctxCfg({ enabled: false }),
    });
    expect(out).toBeCloseTo(101, 10);
  });

  it("falls back to applySlippage without a context", () => {
    expect(applySlippageWithContext(100, "buy", 1, undefined, base, undefined)).toBeCloseTo(101, 10);
  });

  it("stays defensive: undefined cfg gives refPrice back", () => {
    expect(applySlippageWithContext(100, "buy", 1, undefined, undefined, { barTime: SAT_04 })).toBe(100);
  });

  it("does nothing when the base model is off", () => {
    const off: SlippageSettings = { ...base, kind: "none" };
    expect(applySlippageWithContext(100, "buy", 1, undefined, off, { barTime: SAT_04 })).toBe(100);
  });

  it("never produces a negative sell price", () => {
    const huge: SlippageSettings = { ...base, bps: 1_000_000 };
    expect(applySlippageWithContext(100, "sell", 1, undefined, huge, { barTime: SAT_04 })).toBe(0);
  });
});

describe("describeSlippageContext", () => {
  it("mentions the dead hours and the caps", () => {
    const s = describeSlippageContext(DEFAULT_SLIPPAGE_CONTEXT);
    expect(s).toContain("dead h3,4,5,21,22");
    expect(s).toContain("weekend x2");
    expect(s).toContain("cap x4");
  });

  it("reports when it is off and survives undefined", () => {
    expect(describeSlippageContext(ctxCfg({ enabled: false }))).toBe("context off");
    expect(typeof describeSlippageContext(undefined)).toBe("string");
  });
});
