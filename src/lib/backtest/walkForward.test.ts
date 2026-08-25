import { describe, it, expect } from "vitest";
import { hasOverlappingTestWindows, planWalkForward } from "./walkForward.ts";

const DAY = 86_400;
const start = Date.UTC(2025, 0, 1) / 1000;

describe("planWalkForward", () => {
  it("puts the test window immediately after the train window, never inside it", () => {
    const plan = planWalkForward(start, start + 120 * DAY - 1, { trainDays: 60, testDays: 30 });
    expect(plan.folds).toHaveLength(2);
    for (const fold of plan.folds) {
      expect(fold.testFromSec).toBe(fold.trainToSec + 1);
      expect(fold.trainToSec - fold.trainFromSec + 1).toBe(60 * DAY);
      expect(fold.testToSec - fold.testFromSec + 1).toBe(30 * DAY);
    }
  });

  it("tiles the test windows without overlap by default", () => {
    const plan = planWalkForward(start, start + 150 * DAY - 1, { trainDays: 60, testDays: 30 });
    expect(plan.stepDays).toBe(30);
    for (let i = 1; i < plan.folds.length; i++) {
      expect(plan.folds[i].testFromSec).toBe(plan.folds[i - 1].testToSec + 1);
    }
  });

  it("grows the train window from the start in anchored mode", () => {
    const plan = planWalkForward(start, start + 150 * DAY - 1, { trainDays: 60, testDays: 30, mode: "anchored" });
    expect(plan.folds.every((f) => f.trainFromSec === start)).toBe(true);
    expect(plan.folds[1].trainToSec).toBeGreaterThan(plan.folds[0].trainToSec);
  });

  it("never runs a fold whose test window falls outside the range", () => {
    const plan = planWalkForward(start, start + 100 * DAY - 1, { trainDays: 60, testDays: 30, minFolds: 1 });
    expect(plan.folds).toHaveLength(1);
    expect(plan.leftoverDays).toBeCloseTo(10, 5);
  });

  it("refuses a split that does not reach minFolds", () => {
    expect(() => planWalkForward(start, start + 100 * DAY - 1, { trainDays: 60, testDays: 30, minFolds: 2 })).toThrow(
      /1 fold\(s\) fit in 100.0 day\(s\)/,
    );
  });

  it("rejects nonsense window lengths", () => {
    expect(() => planWalkForward(start, start + 300 * DAY, { trainDays: 0, testDays: 30 })).toThrow(/trainDays/);
    expect(() => planWalkForward(start, start + 300 * DAY, { trainDays: 30, testDays: -1 })).toThrow(/testDays/);
    expect(() => planWalkForward(start, start, { trainDays: 30, testDays: 10 })).toThrow(/range is empty/);
  });

  it("reports the out-of-sample stretch as the union of the test windows", () => {
    const plan = planWalkForward(start, start + 150 * DAY - 1, { trainDays: 60, testDays: 30 });
    expect(plan.testFromSec).toBe(plan.folds[0].testFromSec);
    expect(plan.testToSec).toBe(plan.folds[plan.folds.length - 1].testToSec);
  });
});

describe("hasOverlappingTestWindows", () => {
  it("is false when the test windows tile the range", () => {
    const plan = planWalkForward(start, start + 300 * DAY - 1, { trainDays: 90, testDays: 30 });
    expect(hasOverlappingTestWindows(plan)).toBe(false);
  });

  it("is true when the step is shorter than the test window", () => {
    const plan = planWalkForward(start, start + 300 * DAY - 1, { trainDays: 90, testDays: 30, stepDays: 15 });
    expect(hasOverlappingTestWindows(plan)).toBe(true);
  });
});
