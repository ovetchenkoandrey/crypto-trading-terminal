import { describe, expect, it } from "vitest";
import { groupProfile, hourSpecs, weekdaySpecs } from "./groups.ts";
import { gaussian, mulberry32, normalSeries } from "./random.ts";

describe("groupProfile", () => {
  it("splits by key and reports each group in basis points", () => {
    const keys = Int32Array.from([0, 1, 0, 1]);
    const values = Float64Array.from([0.001, 0.002, 0.003, 0.004]);
    const out = groupProfile(keys, values, [
      { key: 0, label: "a" },
      { key: 1, label: "b" },
    ]);
    expect(out[0].n).toBe(2);
    expect(out[0].meanBps).toBeCloseTo(20, 6);
    expect(out[1].meanBps).toBeCloseTo(30, 6);
    expect(out[0].diffVsRestBps).toBeCloseTo(-10, 6);
  });

  it("finds a group whose mean really is shifted", () => {
    const rng = mulberry32(71);
    const n = 60000;
    const keys = new Int32Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = i % 3;
      values[i] = gaussian(rng) * 0.001 + (keys[i] === 2 ? 0.0002 : 0);
    }
    const out = groupProfile(keys, values, [
      { key: 0, label: "a" },
      { key: 1, label: "b" },
      { key: 2, label: "c" },
    ]);
    expect(Math.abs(out[0].t)).toBeLessThan(3);
    expect(out[2].t).toBeGreaterThan(10);
    expect(out[2].tVsRest).toBeGreaterThan(10);
    expect(out[2].ciLowBps).toBeGreaterThan(0);
  });

  it("detects a group with a different volatility but the same mean", () => {
    const rng = mulberry32(72);
    const n = 60000;
    const keys = new Int32Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = i % 2;
      values[i] = gaussian(rng) * (keys[i] === 1 ? 0.002 : 0.001);
    }
    const out = groupProfile(keys, values, [
      { key: 0, label: "calm" },
      { key: 1, label: "wild" },
    ]);
    expect(Math.abs(out[1].tVsRest)).toBeLessThan(4);
    expect(out[1].volRatioVsRest).toBeGreaterThan(1.8);
    expect(out[1].tVolVsRest).toBeGreaterThan(20);
    expect(out[0].volRatioVsRest).toBeLessThan(0.6);
  });

  it("averages companion series per group", () => {
    const keys = Int32Array.from([0, 0, 1, 1]);
    const values = Float64Array.from([0, 0, 0, 0]);
    const volume = Float64Array.from([10, 20, 100, 200]);
    const out = groupProfile(keys, values, [
      { key: 0, label: "a" },
      { key: 1, label: "b" },
    ], { volume });
    expect(out[0].auxMean.volume).toBeCloseTo(15, 9);
    expect(out[1].auxMean.volume).toBeCloseTo(150, 9);
  });

  it("ignores observations whose key was not asked for", () => {
    const keys = Int32Array.from([0, 1, 9, 9]);
    const values = Float64Array.from([0.001, 0.002, 5, 5]);
    const out = groupProfile(keys, values, [{ key: 0, label: "a" }]);
    expect(out[0].n).toBe(1);
    expect(out.length).toBe(1);
  });

  it("finds no difference where every group is drawn from one law", () => {
    const values = normalSeries(48000, 0.001, mulberry32(73));
    const keys = new Int32Array(values.length);
    for (let i = 0; i < keys.length; i++) keys[i] = i % 24;
    const out = groupProfile(keys, values, hourSpecs());
    // With 24 slices at the 5% level roughly one false alarm is expected;
    // none should be extreme.
    expect(Math.max(...out.map((g) => Math.abs(g.tVsRest)))).toBeLessThan(4);
  });
});

describe("specs", () => {
  it("hourSpecs covers the whole day, zero padded", () => {
    const specs = hourSpecs();
    expect(specs.length).toBe(24);
    expect(specs[3].label).toBe("03:00");
    expect(specs[23].key).toBe(23);
  });

  it("weekdaySpecs starts at Sunday", () => {
    expect(weekdaySpecs()[0].label).toBe("Sun");
    expect(weekdaySpecs().length).toBe(7);
  });
});
