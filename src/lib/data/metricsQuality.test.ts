import { describe, expect, it } from "vitest";
import type { MetricsRow } from "./metricsArchive.ts";
import { assessMetrics } from "./metricsQuality.ts";

const T0 = Date.UTC(2024, 5, 1) / 1000;

function row(timeSec: number, oi = 100): MetricsRow {
  return {
    timeSec,
    openInterest: oi,
    openInterestValue: oi * 1000,
    topTraderAccountRatio: 2,
    topTraderPositionRatio: 1.5,
    accountRatio: 2.3,
    takerVolumeRatio: 0.9,
  };
}

function grid(count: number, step = 300): MetricsRow[] {
  return Array.from({ length: count }, (_, i) => row(T0 + i * step, 100 + i));
}

describe("assessMetrics", () => {
  it("reports a clean series as complete", () => {
    const q = assessMetrics(grid(288));
    expect(q.rows).toBe(288);
    expect(q.coverage).toBeCloseTo(1, 10);
    expect(q.missingSlots).toBe(0);
    expect(q.gaps).toEqual([]);
    expect(q.gapCount).toBe(0);
    expect(q.offGrid).toBe(0);
    expect(q.duplicates).toBe(0);
    expect(q.unordered).toBe(0);
    expect(q.nonPositiveOi).toBe(0);
  });

  it("handles an empty series without inventing numbers", () => {
    const q = assessMetrics([]);
    expect(q).toMatchObject({ rows: 0, firstSec: null, lastSec: null, coverage: 0, missingSlots: 0 });
  });

  it("counts a hole in slots, not in seconds", () => {
    const rows = [...grid(10), row(T0 + 10 * 300 + 3600)];
    const q = assessMetrics(rows);
    expect(q.missingSlots).toBe(12);
    expect(q.gaps).toHaveLength(1);
    expect(q.gaps[0]).toMatchObject({ fromSec: T0 + 9 * 300, missing: 12 });
    expect(q.gapCount).toBe(1);
    expect(q.coverage).toBeLessThan(0.6);
  });

  it("counts every hole even when it lists only the deepest", () => {
    // Five holes of one slot each, a listing capped at two: the count is the
    // honest number, the list is the readable one.
    const rows = [0, 2, 4, 6, 8, 10].map((k, i) => row(T0 + k * 300, 100 + i));
    const q = assessMetrics(rows, { maxGapsListed: 2 });
    expect(q.gapCount).toBe(5);
    expect(q.gaps).toHaveLength(2);
    expect(q.missingSlots).toBe(5);
  });

  it("lists the deepest holes first", () => {
    const rows = [row(T0), row(T0 + 600), row(T0 + 600 + 3600)];
    const q = assessMetrics(rows);
    expect(q.gaps.map((g) => g.missing)).toEqual([11, 1]);
  });

  it("flags a timestamp that is not on the five-minute grid", () => {
    const q = assessMetrics([row(T0), row(T0 + 137), row(T0 + 300)]);
    expect(q.offGrid).toBe(1);
  });

  it("counts repeated and out-of-order timestamps", () => {
    const q = assessMetrics([row(T0), row(T0), row(T0 + 300), row(T0)]);
    expect(q.duplicates).toBe(1);
    expect(q.unordered).toBe(1);
  });

  it("counts empty measurements per column", () => {
    const rows = grid(3);
    rows[1].takerVolumeRatio = Number.NaN;
    rows[2].takerVolumeRatio = Number.NaN;
    rows[2].accountRatio = Number.NaN;
    const q = assessMetrics(rows);
    expect(q.emptyFields.takerVolumeRatio).toBe(2);
    expect(q.emptyFields.accountRatio).toBe(1);
    expect(q.emptyFields.openInterest).toBe(0);
  });

  it("finds a frozen open interest, which is a stalled publisher, not a quiet market", () => {
    const rows = [...grid(5), ...Array.from({ length: 8 }, (_, i) => row(T0 + (5 + i) * 300, 500))];
    const q = assessMetrics(rows, { flatMin: 6 });
    expect(q.flatRuns).toHaveLength(1);
    expect(q.flatRuns[0]).toMatchObject({ length: 8, value: 500 });
    expect(q.flatRows).toBe(8);
  });

  it("does not call an ordinary series frozen", () => {
    expect(assessMetrics(grid(50), { flatMin: 6 }).flatRuns).toEqual([]);
  });

  it("measures the step distribution of open interest and where the extreme sits", () => {
    const rows = grid(20);
    rows[10].openInterest = rows[9].openInterest * 2;
    const q = assessMetrics(rows);
    expect(q.maxAbsStepLogOi).toBeGreaterThan(0.6);
    expect(q.maxAbsStepAtSec).toBe(T0 + 10 * 300);
    expect(q.stepSdLogOi).toBeGreaterThan(0);
  });

  it("ignores steps that span a hole when measuring the step distribution", () => {
    const rows = [row(T0, 100), row(T0 + 3600, 1000)];
    const q = assessMetrics(rows);
    expect(q.maxAbsStepLogOi).toBe(0);
    expect(q.maxAbsStepAtSec).toBeNull();
  });

  it("counts a non-positive open interest as unusable", () => {
    const rows = grid(4);
    rows[2].openInterest = 0;
    expect(assessMetrics(rows).nonPositiveOi).toBe(1);
  });
});
