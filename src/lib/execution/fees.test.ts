import { describe, it, expect } from "vitest";
import {
  BYBIT_LINEAR_FEES,
  BYBIT_SPOT_FEES,
  DEFAULT_FEE_SETTINGS,
  computeFee,
  computeOrderFee,
  computeRoundTripFee,
  describeFees,
  feeRateFor,
  feeSettingsFromFlatRate,
  inferFeeRole,
  normalizeFeeSettings,
  roundTripRate,
  type FeeSettings,
} from "./fees";

const linear = BYBIT_LINEAR_FEES;

describe("normalizeFeeSettings", () => {
  it("falls back to Bybit linear defaults when cfg is undefined", () => {
    expect(normalizeFeeSettings(undefined)).toEqual(DEFAULT_FEE_SETTINGS);
  });

  it("never turns an unknown config into free trading", () => {
    const out = normalizeFeeSettings(undefined);
    expect(out.makerRate).toBeGreaterThan(0);
    expect(out.takerRate).toBeGreaterThan(0);
  });

  it("repairs individual garbage fields without dropping the good ones", () => {
    const out = normalizeFeeSettings({ makerRate: NaN, takerRate: 0.001 });
    expect(out.makerRate).toBe(DEFAULT_FEE_SETTINGS.makerRate);
    expect(out.takerRate).toBe(0.001);
  });

  it("clamps negative rates to zero (maker rebates are not modelled)", () => {
    expect(normalizeFeeSettings({ makerRate: -0.0001, takerRate: 0.00055 }).makerRate).toBe(0);
  });

  it("returns a copy, not the shared default object", () => {
    const out = normalizeFeeSettings(undefined);
    out.makerRate = 999;
    expect(DEFAULT_FEE_SETTINGS.makerRate).toBe(0.0002);
  });
});

describe("feeRateFor", () => {
  it("separates maker from taker", () => {
    expect(feeRateFor("maker", linear)).toBe(0.0002);
    expect(feeRateFor("taker", linear)).toBe(0.00055);
  });

  it("spot has the same rate on both sides", () => {
    expect(feeRateFor("maker", BYBIT_SPOT_FEES)).toBe(0.001);
    expect(feeRateFor("taker", BYBIT_SPOT_FEES)).toBe(0.001);
  });
});

describe("computeFee", () => {
  it("maker on 10 000 USDT notional is 2 USDT", () => {
    expect(computeFee(10_000, "maker", linear)).toBeCloseTo(2, 10);
  });

  it("taker on 10 000 USDT notional is 5.5 USDT", () => {
    expect(computeFee(10_000, "taker", linear)).toBeCloseTo(5.5, 10);
  });

  it("a limit strategy pays 2.75x less than a market one on the same notional", () => {
    const maker = computeFee(10_000, "maker", linear);
    const taker = computeFee(10_000, "taker", linear);
    expect(taker / maker).toBeCloseTo(2.75, 10);
  });

  it("uses absolute notional and survives non-finite input", () => {
    expect(computeFee(-10_000, "taker", linear)).toBeCloseTo(5.5, 10);
    expect(computeFee(NaN, "taker", linear)).toBe(0);
  });
});

describe("computeOrderFee", () => {
  it("multiplies price by qty", () => {
    expect(computeOrderFee(77_000, 0.001, "taker", linear)).toBeCloseTo(77 * 0.00055, 10);
  });

  it("returns 0 for garbage input instead of NaN", () => {
    expect(computeOrderFee(NaN, 1, "taker", linear)).toBe(0);
    expect(computeOrderFee(100, NaN, "taker", linear)).toBe(0);
  });
});

describe("round trip", () => {
  it("taker in / taker out on linear is 0.11% of notional", () => {
    expect(roundTripRate("taker", "taker", linear)).toBeCloseTo(0.0011, 10);
    expect(computeRoundTripFee(10_000, "taker", "taker", linear)).toBeCloseTo(11, 10);
  });

  it("maker in / maker out is 0.04%", () => {
    expect(roundTripRate("maker", "maker", linear)).toBeCloseTo(0.0004, 10);
  });

  it("mixed maker entry / taker exit is 0.075%", () => {
    expect(roundTripRate("maker", "taker", linear)).toBeCloseTo(0.00075, 10);
  });
});

describe("inferFeeRole", () => {
  it("market always takes", () => {
    expect(inferFeeRole({ type: "market" })).toBe("taker");
  });

  it("stop triggers into a market order, so it takes", () => {
    expect(inferFeeRole({ type: "stop" })).toBe("taker");
  });

  it("resting limit makes", () => {
    expect(inferFeeRole({ type: "limit" })).toBe("maker");
  });

  it("marketable limit takes", () => {
    expect(inferFeeRole({ type: "limit", crossedBook: true })).toBe("taker");
  });

  it("postOnly is maker even when marked as crossing", () => {
    expect(inferFeeRole({ type: "limit", crossedBook: true, postOnly: true })).toBe("maker");
    expect(inferFeeRole({ type: "market", postOnly: true })).toBe("maker");
  });
});

describe("feeSettingsFromFlatRate", () => {
  it("mirrors the legacy single rate onto both sides", () => {
    const out: FeeSettings = feeSettingsFromFlatRate(0.001);
    expect(out).toEqual({ makerRate: 0.001, takerRate: 0.001 });
  });

  it("falls back to the taker default when the legacy rate is missing", () => {
    expect(feeSettingsFromFlatRate(undefined).takerRate).toBe(DEFAULT_FEE_SETTINGS.takerRate);
  });
});

describe("describeFees", () => {
  it("renders both rates as percentages", () => {
    expect(describeFees(linear)).toBe("maker 0.02% / taker 0.055%");
    expect(describeFees(BYBIT_SPOT_FEES)).toBe("maker 0.1% / taker 0.1%");
  });

  it("does not throw on undefined", () => {
    expect(describeFees(undefined)).toBe("maker 0.02% / taker 0.055%");
  });
});
