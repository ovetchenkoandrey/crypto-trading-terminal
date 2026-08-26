import { describe, expect, it } from "vitest";
import { pearson, quantileBucketIndex, ranks, spearman, standardize } from "./rank.ts";

describe("ranks", () => {
  it("ranks from 1 upward", () => {
    expect(Array.from(ranks([30, 10, 20]))).toEqual([3, 1, 2]);
  });

  it("ties share their mean rank", () => {
    expect(Array.from(ranks([5, 5, 1, 9]))).toEqual([2.5, 2.5, 1, 4]);
  });

  it("a constant series gives every element the same rank", () => {
    expect(Array.from(ranks([7, 7, 7, 7]))).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  it("the ranks of n distinct values are a permutation of 1..n", () => {
    const v = Array.from({ length: 500 }, (_, i) => Math.sin(i * 1.7));
    const r = Array.from(ranks(v)).sort((a, b) => a - b);
    for (let i = 0; i < 500; i++) expect(r[i]).toBe(i + 1);
  });
});

describe("standardize", () => {
  it("gives mean 0 and standard deviation 1", () => {
    const v = Float64Array.from([1, 2, 3, 4, 5]);
    expect(standardize(v)).toBe(true);
    let sum = 0;
    let sq = 0;
    for (const x of v) {
      sum += x;
      sq += x * x;
    }
    expect(sum / v.length).toBeCloseTo(0, 12);
    expect(Math.sqrt(sq / v.length)).toBeCloseTo(1, 12);
  });

  it("refuses a constant series", () => {
    expect(standardize(Float64Array.from([2, 2, 2]))).toBe(false);
  });
});

describe("correlations", () => {
  it("pearson is 1 for a rising line and -1 for a falling one", () => {
    const x = [1, 2, 3, 4];
    expect(pearson(x, [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson(x, [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });

  it("spearman is 1 for any increasing transform, pearson is not", () => {
    const x = [1, 2, 3, 4, 5, 6];
    const y = x.map((v) => Math.exp(v * 2));
    expect(spearman(x, y)).toBeCloseTo(1, 12);
    expect(pearson(x, y)).toBeLessThan(0.9);
  });

  it("a single outlier swings pearson but barely moves spearman", () => {
    const n = 200;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      x.push(i % 7);
      y.push(((i * 13) % 11) - 5);
    }
    const basePearson = pearson(x, y);
    const baseSpearman = spearman(x, y);
    x.push(1e6);
    y.push(1e6);
    expect(Math.abs(pearson(x, y) - basePearson)).toBeGreaterThan(0.5);
    expect(Math.abs(spearman(x, y) - baseSpearman)).toBeLessThan(0.1);
  });

  it("is NaN on a degenerate series", () => {
    expect(Number.isNaN(pearson([1, 1, 1], [1, 2, 3]))).toBe(true);
  });
});

describe("quantileBucketIndex", () => {
  it("splits a uniform sample into equal parts", () => {
    const v = Array.from({ length: 1000 }, (_, i) => i);
    const b = quantileBucketIndex(v, 5);
    const counts = new Array(5).fill(0);
    for (const x of b) counts[x]++;
    expect(counts).toEqual([200, 200, 200, 200, 200]);
  });

  it("puts the smallest value in bucket 0 and the largest in the top bucket", () => {
    const v = [9, 1, 5, 7, 3];
    const b = quantileBucketIndex(v, 5);
    expect(b[1]).toBe(0);
    expect(b[0]).toBe(4);
  });

  it("a feature that is all ties collapses into one bucket", () => {
    const b = quantileBucketIndex([4, 4, 4, 4, 4, 4], 3);
    expect(new Set(Array.from(b)).size).toBe(1);
  });

  it("count below two is a no-op", () => {
    expect(Array.from(quantileBucketIndex([3, 1, 2], 1))).toEqual([0, 0, 0]);
  });
});
