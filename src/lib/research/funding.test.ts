import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import { fundingCarry, fundingWindowReturns, type FundingPoint } from "./funding.ts";
import { gaussian, mulberry32 } from "./random.ts";
import { createPriceLookup } from "./series.ts";

const HOUR = 3600;
const EIGHT_HOURS = 8 * HOUR;

function minuteBars(count: number, priceAt: (i: number) => number, startSec = 0): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const c = priceAt(i);
    return { time: startSec + i * 60, open: c, high: c, low: c, close: c, volume: 1 };
  });
}

describe("fundingWindowReturns", () => {
  it("measures the move over each window around settlement", () => {
    // Price steps up 1% at minute 100 and nowhere else.
    const bars = minuteBars(400, (i) => (i < 100 ? 100 : 101));
    const at = createPriceLookup(bars);
    const events: FundingPoint[] = [{ time: 100 * 60, rate: 0.0001 }];
    const out = fundingWindowReturns(events, at, [
      { label: "before", fromMin: -10, toMin: 0 },
      { label: "after", fromMin: 0, toMin: 10 },
    ]);
    expect(out[0].meanBps).toBeCloseTo(Math.log(101 / 100) * 1e4, 6);
    expect(out[1].meanBps).toBeCloseTo(0, 9);
    expect(out[0].n).toBe(1);
  });

  it("skips settlements whose window falls outside the data", () => {
    const bars = minuteBars(100, () => 100);
    const at = createPriceLookup(bars);
    const events: FundingPoint[] = [
      { time: 10 * 60, rate: 0 },
      { time: 50 * 60, rate: 0 },
    ];
    const out = fundingWindowReturns(events, at, [{ label: "wide", fromMin: -30, toMin: 30 }]);
    expect(out[0].n).toBe(1);
  });

  it("finds nothing in a window where nothing happens", () => {
    const rng = mulberry32(101);
    let price = 100;
    const closes: number[] = [];
    for (let i = 0; i < 20000; i++) {
      price *= Math.exp(gaussian(rng) * 0.0005);
      closes.push(price);
    }
    const bars = minuteBars(closes.length, (i) => closes[i]);
    const at = createPriceLookup(bars);
    const events: FundingPoint[] = [];
    for (let t = EIGHT_HOURS; t < 20000 * 60 - EIGHT_HOURS; t += EIGHT_HOURS) events.push({ time: t, rate: 0.0001 });
    const out = fundingWindowReturns(events, at, [{ label: "after", fromMin: 0, toMin: 30 }]);
    expect(Math.abs(out[0].t)).toBeLessThan(3);
    expect(out[0].n).toBeGreaterThan(30);
  });
});

describe("fundingCarry", () => {
  it("credits the rate when price does not move", () => {
    const bars = minuteBars(2000, () => 100);
    const at = createPriceLookup(bars);
    const events: FundingPoint[] = [];
    for (let t = 0; t + EIGHT_HOURS < 2000 * 60; t += EIGHT_HOURS) events.push({ time: t, rate: 0.0005 });
    const out = fundingCarry(events, at, EIGHT_HOURS, 1);
    // Rate 5 bp collected, price flat: carry is the rate itself.
    expect(out[0].carryBps).toBeCloseTo(5, 6);
    expect(out[0].winRate).toBe(1);
  });

  it("charges the price move against the side that receives", () => {
    // Price rises 1% over each interval while funding is positive, so the
    // short collects 5 bp and loses about 100.
    const bars = minuteBars(3000, (i) => 100 * Math.pow(1.01, Math.floor((i * 60) / EIGHT_HOURS)));
    const at = createPriceLookup(bars);
    const events: FundingPoint[] = [];
    for (let t = 0; t + EIGHT_HOURS < 3000 * 60; t += EIGHT_HOURS) events.push({ time: t, rate: 0.0005 });
    const out = fundingCarry(events, at, EIGHT_HOURS, 1);
    expect(out[0].carryBps).toBeLessThan(-90);
    expect(out[0].winRate).toBe(0);
  });

  it("splits settlements into rate quantiles", () => {
    const bars = minuteBars(20000, () => 100);
    const at = createPriceLookup(bars);
    const events: FundingPoint[] = [];
    let i = 0;
    for (let t = 0; t + EIGHT_HOURS < 20000 * 60; t += EIGHT_HOURS) {
      events.push({ time: t, rate: (i % 5) * 0.0001 });
      i++;
    }
    const out = fundingCarry(events, at, EIGHT_HOURS, 5);
    expect(out.length).toBe(5);
    expect(out.map((b) => b.label)).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    // Buckets are ordered by rate, so the mean rate must rise across them.
    for (let k = 1; k < out.length; k++) expect(out[k].meanRateBps).toBeGreaterThanOrEqual(out[k - 1].meanRateBps);
  });

  it("ignores settlements with no price on either end", () => {
    const bars = minuteBars(100, () => 100);
    const at = createPriceLookup(bars);
    const out = fundingCarry([{ time: 0, rate: 0.0001 }, { time: 90 * 60, rate: 0.0001 }], at, EIGHT_HOURS, 1);
    expect(out[0].n).toBe(0);
  });
});
