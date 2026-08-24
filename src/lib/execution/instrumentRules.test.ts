import { describe, it, expect } from "vitest";
import {
  BTCUSDT_RULES,
  DEFAULT_INSTRUMENT_RULES,
  getInstrumentRules,
  isMultipleOfStep,
  minTradableQty,
  normalizeOrder,
  quantizeLimitPrice,
  quantizePrice,
  quantizeQty,
  rulesFromBybitInstrument,
  snapToStep,
  stepDecimals,
  validateOrder,
  type InstrumentRules,
} from "./instrumentRules";

const btc = BTCUSDT_RULES;

describe("stepDecimals", () => {
  it("reads the precision off the step", () => {
    expect(stepDecimals(0.001)).toBe(3);
    expect(stepDecimals(0.1)).toBe(1);
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(0.5)).toBe(1);
  });

  it("handles exponential notation", () => {
    expect(stepDecimals(1e-7)).toBe(7);
  });

  it("returns 0 for garbage", () => {
    expect(stepDecimals(0)).toBe(0);
    expect(stepDecimals(NaN)).toBe(0);
  });
});

describe("snapToStep", () => {
  it("floors, ceils and rounds", () => {
    expect(snapToStep(0.0015, 0.001, "floor")).toBe(0.001);
    expect(snapToStep(0.0015, 0.001, "ceil")).toBe(0.002);
    expect(snapToStep(0.0016, 0.001, "nearest")).toBe(0.002);
  });

  it("does not lose a step to binary noise (0.003 / 0.001 = 2.9999...)", () => {
    expect(snapToStep(0.003, 0.001, "floor")).toBe(0.003);
    expect(snapToStep(0.007, 0.001, "floor")).toBe(0.007);
    expect(snapToStep(0.29, 0.01, "floor")).toBe(0.29);
  });

  it("returns a clean decimal, not 0.30000000000000004", () => {
    expect(snapToStep(0.3, 0.1, "nearest")).toBe(0.3);
    expect(snapToStep(77_000.15, 0.1, "floor")).toBe(77_000.1);
  });

  it("passes the value through when the step is unusable", () => {
    expect(snapToStep(1.234, 0, "floor")).toBe(1.234);
    expect(Number.isNaN(snapToStep(NaN, 0.1))).toBe(true);
  });
});

describe("isMultipleOfStep", () => {
  it("accepts exact multiples despite float representation", () => {
    expect(isMultipleOfStep(0.003, 0.001)).toBe(true);
    expect(isMultipleOfStep(77_000.1, 0.1)).toBe(true);
    expect(isMultipleOfStep(0, 0.001)).toBe(true);
  });

  it("rejects values between steps", () => {
    expect(isMultipleOfStep(0.0015, 0.001)).toBe(false);
    expect(isMultipleOfStep(77_000.05, 0.1)).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isMultipleOfStep(NaN, 0.001)).toBe(false);
    expect(isMultipleOfStep(1, 0)).toBe(false);
  });
});

describe("quantizeQty", () => {
  it("floors by default so the order never grows beyond what was sized", () => {
    expect(quantizeQty(0.0019, btc)).toBe(0.001);
    expect(quantizeQty(0.0129, btc)).toBe(0.012);
  });

  it("can ceil or round on request", () => {
    expect(quantizeQty(0.0019, btc, "ceil")).toBe(0.002);
    expect(quantizeQty(0.0016, btc, "nearest")).toBe(0.002);
  });

  it("drops a sub-minimum qty to zero rather than inventing one", () => {
    expect(quantizeQty(0.0004, btc)).toBe(0);
  });

  it("uses the absolute value and survives garbage", () => {
    expect(quantizeQty(-0.0019, btc)).toBe(0.001);
    expect(Number.isNaN(quantizeQty(NaN, btc))).toBe(true);
  });

  it("falls back to defaults when the rules are missing", () => {
    expect(quantizeQty(0.0019, undefined)).toBe(0.001);
  });
});

describe("quantizePrice", () => {
  it("snaps to the tick", () => {
    expect(quantizePrice(77_000.04, btc)).toBe(77_000);
    expect(quantizePrice(77_000.06, btc)).toBe(77_000.1);
  });

  it("quantizeLimitPrice only ever moves the price against the order", () => {
    expect(quantizeLimitPrice(77_000.09, "buy", btc)).toBe(77_000);
    expect(quantizeLimitPrice(77_000.01, "sell", btc)).toBe(77_000.1);
  });
});

describe("validateOrder", () => {
  it("passes a legal BTCUSDT order", () => {
    expect(validateOrder({ qty: 0.001, price: 77_000 }, btc)).toEqual({ ok: true, violations: [] });
  });

  it("rejects a qty below minOrderQty", () => {
    const v = validateOrder({ qty: 0.0005, price: 77_000 }, btc);
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code)).toContain("qty_below_min");
  });

  it("rejects a qty off the lot step", () => {
    const v = validateOrder({ qty: 0.0015, price: 77_000 }, btc);
    expect(v.violations.map((x) => x.code)).toContain("qty_step");
  });

  it("rejects a price off the tick", () => {
    const v = validateOrder({ qty: 0.001, price: 77_000.05 }, btc);
    expect(v.violations.map((x) => x.code)).toContain("price_tick");
  });

  it("rejects an order below the minimum notional", () => {
    const cheap: InstrumentRules = { ...btc, minOrderQty: 0.001, qtyStep: 0.001, minNotional: 5 };
    const v = validateOrder({ qty: 0.001, price: 1_000 }, cheap);
    expect(v.violations.map((x) => x.code)).toContain("notional_below_min");
  });

  it("rejects a qty above maxOrderQty", () => {
    const capped: InstrumentRules = { ...btc, maxOrderQty: 1 };
    expect(validateOrder({ qty: 2, price: 77_000 }, capped).violations.map((x) => x.code))
      .toContain("qty_above_max");
  });

  it("reports invalid numbers without also spamming step violations", () => {
    const v = validateOrder({ qty: 0, price: NaN }, btc);
    expect(v.ok).toBe(false);
    expect(v.violations.map((x) => x.code).sort()).toEqual(["invalid_price", "invalid_qty"]);
  });

  it("collects several violations at once", () => {
    const v = validateOrder({ qty: 0.00051, price: 77_000.05 }, btc);
    expect(v.violations.map((x) => x.code).sort())
      .toEqual(["price_tick", "qty_below_min", "qty_step"]);
  });

  it("uses the defaults when rules are missing", () => {
    expect(validateOrder({ qty: 0.001, price: 77_000 }, undefined).ok).toBe(true);
  });
});

describe("normalizeOrder", () => {
  it("quantizes then validates in one pass", () => {
    const out = normalizeOrder({ qty: 0.00194, price: 77_000.07 }, btc);
    expect(out.qty).toBe(0.001);
    expect(out.price).toBe(77_000.1);
    expect(out.adjusted).toBe(true);
    expect(out.ok).toBe(true);
  });

  it("leaves an already legal order alone", () => {
    const out = normalizeOrder({ qty: 0.002, price: 77_000.1 }, btc);
    expect(out.adjusted).toBe(false);
    expect(out.ok).toBe(true);
  });

  it("still reports failure when quantisation cannot save the order", () => {
    const out = normalizeOrder({ qty: 0.0004, price: 77_000 }, btc);
    expect(out.qty).toBe(0);
    expect(out.ok).toBe(false);
    expect(out.violations.map((v) => v.code)).toContain("invalid_qty");
  });

  it("rounds a limit price against the order when a side is given", () => {
    expect(normalizeOrder({ qty: 0.001, price: 77_000.09 }, btc, { side: "buy" }).price).toBe(77_000);
    expect(normalizeOrder({ qty: 0.001, price: 77_000.01 }, btc, { side: "sell" }).price).toBe(77_000.1);
  });
});

describe("minTradableQty", () => {
  it("is the lot minimum when the notional minimum is already met", () => {
    expect(minTradableQty(77_000, btc)).toBe(0.001);
  });

  it("grows when the price is too low to reach the minimum notional", () => {
    expect(minTradableQty(1_000, btc)).toBe(0.005);
  });

  it("falls back to the lot minimum on a bad price", () => {
    expect(minTradableQty(0, btc)).toBe(0.001);
  });
});

describe("rulesFromBybitInstrument", () => {
  it("parses the string fields Bybit returns", () => {
    const parsed = rulesFromBybitInstrument({
      symbol: "BTCUSDT",
      priceFilter: { tickSize: "0.10" },
      lotSizeFilter: { minOrderQty: "0.001", qtyStep: "0.001", maxOrderQty: "100", minNotionalValue: "5" },
    });
    expect(parsed).toEqual({
      symbol: "BTCUSDT", minOrderQty: 0.001, qtyStep: 0.001, tickSize: 0.1, minNotional: 5, maxOrderQty: 100,
    });
  });

  it("falls back field by field on a partial payload", () => {
    const parsed = rulesFromBybitInstrument({ symbol: "FOOUSDT" });
    expect(parsed.symbol).toBe("FOOUSDT");
    expect(parsed.minOrderQty).toBe(DEFAULT_INSTRUMENT_RULES.minOrderQty);
    expect(parsed.maxOrderQty).toBeUndefined();
  });

  it("survives undefined", () => {
    expect(rulesFromBybitInstrument(undefined).symbol).toBe(DEFAULT_INSTRUMENT_RULES.symbol);
  });
});

describe("getInstrumentRules", () => {
  it("knows BTCUSDT out of the box", () => {
    expect(getInstrumentRules("BTCUSDT")).toEqual(BTCUSDT_RULES);
  });

  it("returns a non-permissive fallback for an unknown symbol", () => {
    const r = getInstrumentRules("FOOUSDT");
    expect(r.symbol).toBe("FOOUSDT");
    expect(r.minNotional).toBe(DEFAULT_INSTRUMENT_RULES.minNotional);
    expect(r.minOrderQty).toBeGreaterThan(0);
  });
});
