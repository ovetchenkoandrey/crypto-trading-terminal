import { describe, expect, it } from "vitest";
import { DATA_INTERVALS, intervalSeconds, isDataInterval, parseInterval, toBybitInterval } from "./interval.ts";

describe("interval", () => {
  it("maps every canonical interval to seconds and a Bybit code", () => {
    for (const i of DATA_INTERVALS) {
      expect(intervalSeconds(i)).toBeGreaterThan(0);
      expect(toBybitInterval(i)).toBeTruthy();
    }
    expect(intervalSeconds("1m")).toBe(60);
    expect(intervalSeconds("4h")).toBe(14400);
    expect(intervalSeconds("1d")).toBe(86400);
    expect(toBybitInterval("1h")).toBe("60");
    expect(toBybitInterval("1d")).toBe("D");
  });

  it("accepts canonical, Bybit and MetaTrader notations", () => {
    expect(parseInterval("1m")).toBe("1m");
    expect(parseInterval("15M")).toBe("15m");
    expect(parseInterval("1")).toBe("1m");
    expect(parseInterval("60")).toBe("1h");
    expect(parseInterval("720")).toBe("12h");
    expect(parseInterval("D")).toBe("1d");
    expect(parseInterval("M5")).toBe("5m");
    expect(parseInterval("H4")).toBe("4h");
    expect(parseInterval("D1")).toBe("1d");
    expect(parseInterval(" 30m ")).toBe("30m");
  });

  it("throws instead of defaulting on an unknown interval", () => {
    expect(() => parseInterval("7m")).toThrow(/unsupported interval/);
    expect(() => parseInterval("")).toThrow(/empty/);
    expect(() => parseInterval("8h")).toThrow(/unsupported interval/);
    expect(isDataInterval("8h")).toBe(false);
  });
});
