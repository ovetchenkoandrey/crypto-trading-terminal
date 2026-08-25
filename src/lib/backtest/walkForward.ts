// Walk-forward split: turn one time range into consecutive train/test folds.
//
// The point of the split is that no bar used to pick parameters is ever used to
// judge the same fit. So a test window starts on the second after its own train
// window ends, and the only way to buy a longer train window is to give up
// folds. A later fold retraining on an earlier fold's test bars is intended:
// by then those bars are history, which is exactly the situation a live bot
// that refits monthly is in.
//
// Everything here is arithmetic on inclusive UTC-second bounds — the same
// convention `RunSpec.fromSec/toSec` uses.

import { toISO } from "../data/months.ts";

export type WalkForwardMode = "rolling" | "anchored";

export interface WalkForwardDecl {
  /** Length of the parameter-fitting window, in days. */
  trainDays: number;
  /** Length of the untouched validation window, in days. */
  testDays: number;
  /** Distance between fold starts. Defaults to testDays: test windows tile the range without overlap. */
  stepDays?: number;
  /** rolling = fixed-length train window slides; anchored = train window grows from the start. */
  mode?: WalkForwardMode;
  /**
   * Bars of history prepended to every segment so indicators are warm at the
   * first tradable bar. The prefix is traded through but its equity and trades
   * are cut out of the segment's metrics.
   */
  warmupBars?: number;
  /** Fewer folds than this is not a walk-forward, it is one lucky split. */
  minFolds?: number;
}

export interface WalkForwardFold {
  index: number;
  trainFromSec: number;
  trainToSec: number;
  testFromSec: number;
  testToSec: number;
}

export interface WalkForwardPlan {
  mode: WalkForwardMode;
  trainDays: number;
  testDays: number;
  stepDays: number;
  warmupBars: number;
  folds: WalkForwardFold[];
  /** Span actually covered by the test windows, i.e. the honest out-of-sample stretch. */
  testFromSec: number;
  testToSec: number;
  /** Days of the requested range left over after the last fold. */
  leftoverDays: number;
}

const DAY = 86_400;

export const DEFAULT_MIN_FOLDS = 2;

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`walkForward.${name} must be a positive number of days`);
  return value;
}

export function planWalkForward(fromSec: number, toSec: number, decl: WalkForwardDecl): WalkForwardPlan {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
    throw new Error("walkForward: the run range is empty");
  }
  const trainDays = positive("trainDays", decl.trainDays);
  const testDays = positive("testDays", decl.testDays);
  const stepDays = positive("stepDays", decl.stepDays ?? testDays);
  const mode: WalkForwardMode = decl.mode ?? "rolling";
  if (mode !== "rolling" && mode !== "anchored") throw new Error(`walkForward.mode must be rolling or anchored, got "${mode}"`);
  const warmupBars = Math.max(0, Math.floor(decl.warmupBars ?? 0));
  const minFolds = Math.max(1, Math.floor(decl.minFolds ?? DEFAULT_MIN_FOLDS));

  const trainSec = Math.round(trainDays * DAY);
  const testSec = Math.round(testDays * DAY);
  const stepSec = Math.round(stepDays * DAY);

  const folds: WalkForwardFold[] = [];
  for (let i = 0; ; i++) {
    const slideStart = fromSec + i * stepSec;
    const trainToSec = slideStart + trainSec - 1;
    const trainFromSec = mode === "anchored" ? fromSec : slideStart;
    const testFromSec = trainToSec + 1;
    const testToSec = testFromSec + testSec - 1;
    if (testToSec > toSec) break;
    folds.push({ index: folds.length, trainFromSec, trainToSec, testFromSec, testToSec });
  }

  if (folds.length < minFolds) {
    const available = (toSec - fromSec + 1) / DAY;
    throw new Error(
      `walkForward: ${folds.length} fold(s) fit in ${available.toFixed(1)} day(s) of range ` +
        `(${toISO(fromSec)} .. ${toISO(toSec)}) with trainDays=${trainDays}, testDays=${testDays}, stepDays=${stepDays}; ` +
        `minFolds is ${minFolds}. Widen the range or shorten the windows.`,
    );
  }

  const last = folds[folds.length - 1];
  return {
    mode,
    trainDays,
    testDays,
    stepDays,
    warmupBars,
    folds,
    testFromSec: folds[0].testFromSec,
    testToSec: last.testToSec,
    leftoverDays: (toSec - last.testToSec) / DAY,
  };
}

/**
 * True when two test windows cover the same days.
 *
 * A later fold training on an earlier fold's test window is normal and not a
 * problem: by then those bars really are in the past. Test windows overlapping
 * each other is a different matter — the stitched track would count the same
 * days twice, inflating both the trade count and the apparent length of the
 * out-of-sample record. That happens whenever stepDays is below testDays.
 */
export function hasOverlappingTestWindows(plan: WalkForwardPlan): boolean {
  for (let i = 1; i < plan.folds.length; i++) {
    if (plan.folds[i].testFromSec <= plan.folds[i - 1].testToSec) return true;
  }
  return false;
}

export function describeFold(fold: WalkForwardFold): string {
  return (
    `fold ${fold.index + 1}: train ${toISO(fold.trainFromSec)} .. ${toISO(fold.trainToSec)} | ` +
    `test ${toISO(fold.testFromSec)} .. ${toISO(fold.testToSec)}`
  );
}
