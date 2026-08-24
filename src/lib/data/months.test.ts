import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayStartSec,
  daysInMonth,
  daysOfMonth,
  expectedBarsInMonth,
  isMonthKey,
  monthEndSec,
  monthOf,
  monthRange,
  monthStartSec,
  parseMonth,
  toISO,
} from "./months.ts";

describe("months", () => {
  it("converts month keys to UTC boundaries", () => {
    expect(monthStartSec("2024-09")).toBe(Date.UTC(2024, 8, 1) / 1000);
    expect(monthEndSec("2024-09")).toBe(Date.UTC(2024, 9, 1) / 1000);
    expect(monthEndSec("2024-12")).toBe(Date.UTC(2025, 0, 1) / 1000);
    expect(daysInMonth("2024-02")).toBe(29);
    expect(daysInMonth("2025-02")).toBe(28);
    expect(daysInMonth("2024-09")).toBe(30);
  });

  it("rejects malformed month keys", () => {
    expect(() => parseMonth("2024-13")).toThrow();
    expect(() => parseMonth("24-09")).toThrow();
    expect(isMonthKey("2024-00")).toBe(false);
    expect(isMonthKey("2024-09")).toBe(true);
  });

  it("walks months across the year boundary", () => {
    expect(monthRange("2024-11", "2025-02")).toEqual(["2024-11", "2024-12", "2025-01", "2025-02"]);
    expect(monthRange("2024-11", "2024-11")).toEqual(["2024-11"]);
    expect(monthRange("2025-01", "2024-12")).toEqual([]);
    expect(addMonths("2024-12", 1)).toBe("2025-01");
    expect(addMonths("2025-01", -1)).toBe("2024-12");
    expect(addMonths("2025-01", -13)).toBe("2023-12");
  });

  it("locates the month and day of a timestamp", () => {
    expect(monthOf(Date.UTC(2026, 5, 30, 23, 59) / 1000)).toBe("2026-06");
    expect(monthOf(Date.UTC(2026, 6, 1, 0, 0) / 1000)).toBe("2026-07");
    expect(dayStartSec("2026-06-15")).toBe(Date.UTC(2026, 5, 15) / 1000);
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
  });

  it("clips the day list of a running month", () => {
    const all = daysOfMonth("2026-06");
    expect(all).toHaveLength(30);
    expect(all[0]).toBe("2026-06-01");
    const clipped = daysOfMonth("2026-06", Date.UTC(2026, 5, 3, 12) / 1000);
    expect(clipped).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("caps the expected bar count of an unfinished month", () => {
    expect(expectedBarsInMonth("2026-06", 60)).toBe(43200);
    expect(expectedBarsInMonth("2026-06", 60, Date.UTC(2026, 5, 2) / 1000)).toBe(1440);
    expect(expectedBarsInMonth("2026-06", 60, Date.UTC(2026, 4, 1) / 1000)).toBe(0);
    expect(expectedBarsInMonth("2026-06", 3600)).toBe(720);
  });

  it("renders ISO without noise", () => {
    expect(toISO(Date.UTC(2026, 5, 1) / 1000)).toBe("2026-06-01T00:00:00Z");
  });
});
