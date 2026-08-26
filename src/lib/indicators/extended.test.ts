import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import {
  adx,
  aroon,
  awesomeOscillator,
  cci,
  chaikinMoneyFlow,
  choppiness,
  closeLocationValue,
  donchian,
  efficiencyRatio,
  elderRay,
  hurstExponent,
  ichimoku,
  keltner,
  moneyFlowIndex,
  obv,
  parabolicSar,
  percentB,
  roc,
  rollingMax,
  rollingMin,
  rollingSum,
  supertrend,
  trix,
  ultimateOscillator,
  vortex,
  wilderSum,
  williamsR,
} from "./extended";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

/** Deterministic wiggly series, enough structure that the indicators move. */
function wiggle(n: number, drift = 0): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const step = Math.sin(i / 3) * 0.8 + Math.cos(i / 7) * 0.4 + drift;
    const open = price;
    price = price + step;
    const high = Math.max(open, price) + 0.3;
    const low = Math.min(open, price) - 0.3;
    out.push(bar(i * 60, open, high, low, price, 100 + (i % 5) * 10));
  }
  return out;
}

describe("rolling helpers", () => {
  it("rollingMax and rollingMin pad and then track the window", () => {
    const v = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(rollingMax(v, 3)).toEqual([null, null, 4, 4, 5, 9, 9, 9]);
    expect(rollingMin(v, 3)).toEqual([null, null, 1, 1, 1, 1, 2, 2]);
  });

  it("rollingMax matches a naive scan on a long series", () => {
    const v = wiggle(200).map((c) => c.high);
    const fast = rollingMax(v, 14);
    for (let i = 13; i < v.length; i++) {
      let m = -Infinity;
      for (let j = i - 13; j <= i; j++) m = Math.max(m, v[j]);
      expect(fast[i]).toBeCloseTo(m, 12);
    }
  });

  it("rollingSum is exact for a short window", () => {
    expect(rollingSum([1, 2, 3, 4], 2)).toEqual([null, 3, 5, 7]);
  });

  it("rollingSum with period 1 returns the input", () => {
    expect(rollingSum([5, -2, 7], 1)).toEqual([5, -2, 7]);
  });

  it("bad periods give an all-null series", () => {
    expect(rollingMax([1, 2, 3], 0)).toEqual([null, null, null]);
    expect(rollingSum([1, 2, 3], -4)).toEqual([null, null, null]);
  });

  it("wilderSum seeds with the plain sum and then decays", () => {
    const v = [2, 2, 2, 2, 2];
    const out = wilderSum(v, 3);
    expect(out[2]).toBeCloseTo(6, 12);
    expect(out[3]).toBeCloseTo(6, 12);
    expect(out[4]).toBeCloseTo(6, 12);
  });

  it("wilderSum honours the start offset", () => {
    const out = wilderSum([999, 1, 1, 1], 3, 1);
    expect(out[0]).toBeNull();
    expect(out[2]).toBeNull();
    expect(out[3]).toBeCloseTo(3, 12);
  });
});

describe("adx", () => {
  it("is null before the second smoothing has filled", () => {
    const c = wiggle(40);
    const r = adx(c, 14);
    expect(r.adx[20]).toBeNull();
    expect(r.adx[c.length - 1]).not.toBeNull();
  });

  it("+DI dominates in a clean uptrend and ADX is high", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) c.push(bar(i * 60, 100 + i, 100.5 + i, 99.5 + i, 100.4 + i));
    const r = adx(c, 14);
    const last = c.length - 1;
    expect(r.plusDi[last] as number).toBeGreaterThan(r.minusDi[last] as number);
    expect(r.adx[last] as number).toBeGreaterThan(50);
  });

  it("-DI dominates in a clean downtrend", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) c.push(bar(i * 60, 100 - i, 100.5 - i, 99.5 - i, 99.6 - i));
    const r = adx(c, 14);
    const last = c.length - 1;
    expect(r.minusDi[last] as number).toBeGreaterThan(r.plusDi[last] as number);
  });

  it("DI values stay inside 0..100", () => {
    const c = wiggle(300);
    const r = adx(c, 14);
    for (let i = 0; i < c.length; i++) {
      const v = r.plusDi[i];
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("a too-short series yields nothing", () => {
    expect(adx(wiggle(5), 14).adx.every((v) => v === null)).toBe(true);
  });
});

describe("ichimoku", () => {
  it("kijun is the midpoint of the 26-bar range", () => {
    const c = wiggle(120);
    const r = ichimoku(c);
    const i = 100;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - 25; j <= i; j++) {
      hi = Math.max(hi, c[j].high);
      lo = Math.min(lo, c[j].low);
    }
    expect(r.kijun[i] as number).toBeCloseTo((hi + lo) / 2, 10);
  });

  it("the cloud at bar i is the senkou computed `displacement` bars earlier", () => {
    const c = wiggle(200);
    const r = ichimoku(c, 9, 26, 52, 26);
    const i = 150;
    const a = r.senkouA[i - 26] as number;
    const b = r.senkouB[i - 26] as number;
    expect(r.cloudTop[i] as number).toBeCloseTo(Math.max(a, b), 12);
    expect(r.cloudBottom[i] as number).toBeCloseTo(Math.min(a, b), 12);
  });

  it("no displacement makes the cloud the current senkou", () => {
    const c = wiggle(120);
    const r = ichimoku(c, 9, 26, 52, 0);
    const i = 100;
    expect(r.cloudTop[i] as number).toBeCloseTo(Math.max(r.senkouA[i] as number, r.senkouB[i] as number), 12);
  });
});

describe("channels", () => {
  it("keltner bands sit mult ATR around the EMA", () => {
    const c = wiggle(120);
    const k = keltner(c, 20, 20, 2);
    const i = 100;
    const width = (k.upper[i] as number) - (k.mid[i] as number);
    expect(width).toBeGreaterThan(0);
    expect((k.mid[i] as number) - (k.lower[i] as number)).toBeCloseTo(width, 10);
  });

  it("donchian brackets the window highs and lows", () => {
    const c = wiggle(100);
    const d = donchian(c, 20);
    const i = 80;
    for (let j = i - 19; j <= i; j++) {
      expect(c[j].high).toBeLessThanOrEqual(d.upper[i] as number);
      expect(c[j].low).toBeGreaterThanOrEqual(d.lower[i] as number);
    }
  });

  it("donchian mid is the average of the two edges", () => {
    const d = donchian(wiggle(60), 10);
    const i = 50;
    expect(d.mid[i] as number).toBeCloseTo(((d.upper[i] as number) + (d.lower[i] as number)) / 2, 12);
  });
});

describe("supertrend", () => {
  it("stays long through a rising market", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 80; i++) c.push(bar(i * 60, 100 + i, 100.6 + i, 99.6 + i, 100.5 + i));
    const s = supertrend(c, 10, 3);
    expect(s.direction[79]).toBe(1);
    expect(s.value[79] as number).toBeLessThan(c[79].close);
  });

  it("flips to short when the market turns over", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) c.push(bar(i * 60, 100 + i, 100.6 + i, 99.6 + i, 100.5 + i));
    for (let i = 0; i < 60; i++) c.push(bar((60 + i) * 60, 160 - 2 * i, 160.6 - 2 * i, 159.4 - 2 * i, 159.5 - 2 * i));
    const s = supertrend(c, 10, 3);
    expect(s.direction[c.length - 1]).toBe(-1);
  });

  it("direction is only ever +1 or -1 once defined", () => {
    const s = supertrend(wiggle(200), 10, 3);
    for (const d of s.direction) if (d !== null) expect(Math.abs(d)).toBe(1);
  });
});

describe("oscillators", () => {
  it("cci is zero when the typical price sits on its own average", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) c.push(bar(i * 60, 100, 101, 99, 100));
    expect(cci(c, 20)[25]).toBe(0);
  });

  it("cci goes strongly positive above the mean", () => {
    const c = wiggle(120, 0.5);
    const v = cci(c, 20)[100] as number;
    expect(v).toBeGreaterThan(0);
  });

  it("williamsR is 0 at the top of its range and -100 at the bottom", () => {
    const c = wiggle(60);
    const w = williamsR(c, 14);
    for (let i = 14; i < c.length; i++) {
      const v = w[i] as number;
      expect(v).toBeLessThanOrEqual(0);
      expect(v).toBeGreaterThanOrEqual(-100);
    }
    const rising: Candle[] = [];
    for (let i = 0; i < 30; i++) rising.push(bar(i * 60, 100 + i, 101 + i, 99 + i, 101 + i));
    expect(williamsR(rising, 14)[29] as number).toBeCloseTo(0, 6);
  });

  it("roc is the percent change over the lookback", () => {
    expect(roc([100, 110, 121], 1)?.[1] as number).toBeCloseTo(10, 10);
    expect(roc([100, 110, 121], 2)?.[2] as number).toBeCloseTo(21, 10);
  });

  it("ultimate oscillator stays in 0..100", () => {
    const u = ultimateOscillator(wiggle(200));
    for (const v of u) if (v !== null) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("awesome oscillator is positive when the fast median leads", () => {
    const c = wiggle(120, 0.6);
    expect(awesomeOscillator(c)[100] as number).toBeGreaterThan(0);
  });

  it("trix is zero on a flat series and positive on a rising one", () => {
    const flat = new Array(120).fill(100);
    const t = trix(flat, 15);
    expect(t[119] as number).toBeCloseTo(0, 10);
    const rising = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.01, i));
    expect(trix(rising, 15)[199] as number).toBeGreaterThan(0);
  });

  it("percentB is 0.5 on a flat-ish series centred on its mean", () => {
    const v = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 2));
    const b = percentB(v, 20, 2);
    for (let i = 20; i < v.length; i++) {
      expect(b[i] as number).toBeGreaterThan(-0.5);
      expect(b[i] as number).toBeLessThan(1.5);
    }
  });
});

describe("volume indicators", () => {
  it("obv accumulates volume with the sign of the close change", () => {
    const c = [bar(0, 10, 10, 10, 10, 5), bar(60, 10, 11, 10, 11, 7), bar(120, 11, 11, 10, 10, 3)];
    expect(obv(c)).toEqual([0, 7, 4]);
  });

  it("mfi is 100 when every bar rises and 0 when every bar falls", () => {
    const up: Candle[] = [];
    for (let i = 0; i < 30; i++) up.push(bar(i * 60, 100 + i, 101 + i, 99 + i, 100.5 + i));
    expect(moneyFlowIndex(up, 14)[29] as number).toBeCloseTo(100, 6);
    const down: Candle[] = [];
    for (let i = 0; i < 30; i++) down.push(bar(i * 60, 100 - i, 101 - i, 99 - i, 100.5 - i));
    expect(moneyFlowIndex(down, 14)[29] as number).toBeCloseTo(0, 6);
  });

  it("closeLocationValue is +1 at the high and -1 at the low", () => {
    expect(closeLocationValue(bar(0, 10, 12, 8, 12))).toBeCloseTo(1, 12);
    expect(closeLocationValue(bar(0, 10, 12, 8, 8))).toBeCloseTo(-1, 12);
    expect(closeLocationValue(bar(0, 10, 12, 12, 12))).toBe(0);
  });

  it("cmf lands in -1..1 and follows the close location", () => {
    const c = wiggle(120);
    const f = chaikinMoneyFlow(c, 20);
    for (const v of f) if (v !== null) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    const topClose: Candle[] = [];
    for (let i = 0; i < 40; i++) topClose.push(bar(i * 60, 100, 102, 98, 102, 50));
    expect(chaikinMoneyFlow(topClose, 20)[30] as number).toBeCloseTo(1, 10);
  });
});

describe("parabolicSar", () => {
  it("trails below price in an uptrend", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) c.push(bar(i * 60, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
    const s = parabolicSar(c);
    expect(s.direction[59]).toBe(1);
    expect(s.sar[59] as number).toBeLessThan(c[59].low);
  });

  it("flips direction when the trend reverses", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 40; i++) c.push(bar(i * 60, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
    for (let i = 0; i < 40; i++) c.push(bar((40 + i) * 60, 140 - 2 * i, 141 - 2 * i, 138 - 2 * i, 139 - 2 * i));
    const s = parabolicSar(c);
    expect(s.direction[79]).toBe(-1);
  });

  it("handles a two-bar series without throwing", () => {
    const s = parabolicSar([bar(0, 1, 2, 0.5, 1.5), bar(60, 1.5, 2.5, 1, 2)]);
    expect(s.direction[1]).toBe(1);
  });
});

describe("aroon and vortex", () => {
  it("aroon up is 100 when the newest bar is the window high", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 40; i++) c.push(bar(i * 60, 100 + i, 101 + i, 99 + i, 100.5 + i));
    const a = aroon(c, 25);
    expect(a.up[39] as number).toBeCloseTo(100, 10);
    expect(a.down[39] as number).toBeCloseTo(0, 10);
    expect(a.oscillator[39] as number).toBeCloseTo(100, 10);
  });

  it("aroon oscillator lives in -100..100", () => {
    const a = aroon(wiggle(200), 25);
    for (const v of a.oscillator) if (v !== null) {
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("vortex diff is positive in an uptrend", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) c.push(bar(i * 60, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
    const v = vortex(c, 14);
    expect(v.diff[59] as number).toBeGreaterThan(0);
    expect(v.plus[59] as number).toBeGreaterThan(v.minus[59] as number);
  });

  it("vortex diff equals plus minus minus", () => {
    const v = vortex(wiggle(120), 14);
    const i = 100;
    expect(v.diff[i] as number).toBeCloseTo((v.plus[i] as number) - (v.minus[i] as number), 12);
  });
});

describe("elderRay and choppiness", () => {
  it("elder ray bull is above bear by the bar range", () => {
    const c = wiggle(120);
    const e = elderRay(c, 13);
    const i = 100;
    expect((e.bull[i] as number) - (e.bear[i] as number)).toBeCloseTo(c[i].high - c[i].low, 10);
  });

  it("choppiness is near 100 for a market that goes nowhere", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const up = i % 2 === 0;
      c.push(bar(i * 60, 100, up ? 101 : 100, up ? 100 : 99, up ? 101 : 99));
    }
    expect(choppiness(c, 14)[70] as number).toBeGreaterThan(80);
  });

  it("choppiness is low for a straight trend", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 80; i++) c.push(bar(i * 60, 100 + i, 100.2 + i, 99.9 + i, 100.1 + i));
    expect(choppiness(c, 14)[70] as number).toBeLessThan(40);
  });
});

describe("hurstExponent", () => {
  it("is near 1 for a straight line", () => {
    const v = Array.from({ length: 300 }, (_, i) => i);
    const h = hurstExponent(v, 128);
    expect(h[299] as number).toBeGreaterThan(0.9);
  });

  it("is near 0.5 for a random walk", () => {
    // Deterministic pseudo-random walk so the assertion cannot flake.
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const v: number[] = [0];
    for (let i = 1; i < 4000; i++) v.push(v[i - 1] + rnd());
    const h = hurstExponent(v, 512);
    const tail = h.slice(2000).filter((x): x is number => x !== null);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(0.35);
    expect(avg).toBeLessThan(0.65);
  });

  it("is well below 0.5 for an anti-persistent series", () => {
    let seed = 777;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const v: number[] = [0];
    for (let i = 1; i < 2000; i++) v.push(-0.8 * v[i - 1] + rnd());
    const h = hurstExponent(v, 512);
    const tail = h.slice(1000).filter((x): x is number => x !== null);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeLessThan(0.25);
  });

  it("returns nulls when the window cannot hold the lags", () => {
    // period 3 leaves only lag 1 usable (2 * lag must fit the window), and one
    // point cannot define a slope.
    expect(hurstExponent([1, 2, 3, 4], 3).every((v) => v === null)).toBe(true);
    expect(hurstExponent([1, 2, 3, 4], 0).every((v) => v === null)).toBe(true);
  });
});

describe("efficiencyRatio", () => {
  it("is 1 for a monotone series", () => {
    const v = Array.from({ length: 40 }, (_, i) => i);
    expect(efficiencyRatio(v, 10)[30] as number).toBeCloseTo(1, 10);
  });

  it("is 0 when price returns to where it started", () => {
    const v = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    expect(efficiencyRatio(v, 10)[10] as number).toBeCloseTo(0, 10);
  });

  it("stays in 0..1", () => {
    const e = efficiencyRatio(wiggle(200).map((c) => c.close), 20);
    for (const v of e) if (v !== null) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("causality", () => {
  it("no indicator changes a past value when future bars arrive", () => {
    const full = wiggle(400);
    const prefix = full.slice(0, 300);
    const at = 250;
    const closes = (c: Candle[]) => c.map((x) => x.close);

    const checks: [string, (c: Candle[]) => Series][] = [
      ["adx", (c) => adx(c, 14).adx],
      ["plusDi", (c) => adx(c, 14).plusDi],
      ["kijun", (c) => ichimoku(c).kijun],
      ["cloudTop", (c) => ichimoku(c).cloudTop],
      ["keltner", (c) => keltner(c, 20, 20, 2).upper],
      ["donchian", (c) => donchian(c, 20).upper],
      ["supertrend", (c) => supertrend(c, 10, 3).value],
      ["cci", (c) => cci(c, 20)],
      ["williamsR", (c) => williamsR(c, 14)],
      ["mfi", (c) => moneyFlowIndex(c, 14)],
      ["cmf", (c) => chaikinMoneyFlow(c, 20)],
      ["uo", (c) => ultimateOscillator(c)],
      ["ao", (c) => awesomeOscillator(c)],
      ["sar", (c) => parabolicSar(c).sar],
      ["aroon", (c) => aroon(c, 25).oscillator],
      ["vortex", (c) => vortex(c, 14).diff],
      ["trix", (c) => trix(closes(c), 15)],
      ["elderRay", (c) => elderRay(c, 13).bull],
      ["choppiness", (c) => choppiness(c, 14)],
      ["hurst", (c) => hurstExponent(closes(c), 128)],
      ["efficiency", (c) => efficiencyRatio(closes(c), 20)],
      ["percentB", (c) => percentB(closes(c), 20, 2)],
      ["roc", (c) => roc(closes(c), 10)],
    ];

    for (const [name, fn] of checks) {
      const a = fn(prefix)[at];
      const b = fn(full)[at];
      if (a === null) {
        expect(b, name).toBeNull();
        continue;
      }
      expect(b as number, name).toBeCloseTo(a as number, 9);
    }
  });
});

type Series = (number | null)[];
