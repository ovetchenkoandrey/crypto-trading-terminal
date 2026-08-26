import {
  atr,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  stdev,
  stochastic,
  typicalPrice,
  vwap,
  type Series,
} from "../indicators/core.ts";
import {
  adx,
  aroon,
  awesomeOscillator,
  cci,
  chaikinMoneyFlow,
  choppiness,
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
  rollingSum,
  supertrend,
  trix,
  ultimateOscillator,
  vortex,
  williamsR,
} from "../indicators/extended.ts";
import {
  amihudIlliquidity,
  bodyRatio,
  closePosition,
  gapRatio,
  garmanKlassVol,
  logReturnSeries,
  lowerWick,
  parkinsonVol,
  rangeToRealized,
  realizedVol,
  rollingKurtosis,
  rollingSkew,
  rollingZScore,
  signedRunLength,
  upperWick,
  volumeImbalance,
} from "../indicators/microstructure.ts";
import type { Candle } from "../types.ts";

/**
 * The catalogue of things to screen.
 *
 * Two rules shape every entry.
 *
 * Causality. The value at bar i uses bars 0..i and nothing else. Every
 * underlying indicator is written that way, and the Ichimoku cloud is taken in
 * its displaced form so it is the cloud that was actually on screen.
 *
 * Scale invariance. The screen ranks a feature over a five-year sample in which
 * BTC went from four to a hundred thousand dollars and minute volume moved by
 * orders of magnitude. A raw level would rank chronologically and its
 * correlation with anything would be a report about the trend of the sample, not
 * about the feature. So distances are divided by ATR, volumes are z-scored
 * against their own recent window, and volatilities appear as ratios.
 */

export type FeatureGroup =
  | "trend"
  | "momentum"
  | "meanReversion"
  | "volume"
  | "volatility"
  | "shape";

export interface FeatureSpec {
  name: string;
  group: FeatureGroup;
  /** One line, used verbatim in the report. */
  note: string;
  compute(candles: Candle[]): Series;
}

function empty(n: number): Series {
  return new Array(n).fill(null);
}

function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** a / b elementwise, null where either is missing or b is zero. */
function ratio(a: Series, b: Series): Series {
  const out = empty(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null || !(Math.abs(y) > 0)) continue;
    out[i] = x / y;
  }
  return out;
}

function diff(a: Series, b: Series): Series {
  const out = empty(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null) continue;
    out[i] = x - y;
  }
  return out;
}

function fromNumbers(values: readonly number[]): Series {
  return values.map((v) => (Number.isFinite(v) ? v : null));
}

function logSeries(values: Series): Series {
  return values.map((v) => (v !== null && v > 0 ? Math.log(v) : null));
}

/** Distance of close from a level, in ATR units. */
function distanceInAtr(candles: Candle[], level: Series, atrPeriod: number): Series {
  const a = atr(candles, atrPeriod);
  const out = empty(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const l = level[i];
    const v = a[i];
    if (l === null || v === null || !(v > 0)) continue;
    out[i] = (candles[i].close - l) / v;
  }
  return out;
}

/** Cached per-candle-array helpers, so ATR is not recomputed sixty times. */
function memo<T>(fn: (c: Candle[]) => T): (c: Candle[]) => T {
  let key: Candle[] | null = null;
  let value: T | null = null;
  return (c: Candle[]): T => {
    if (key === c && value !== null) return value;
    key = c;
    value = fn(c);
    return value;
  };
}

const atr14 = memo((c: Candle[]) => atr(c, 14));
const atr100 = memo((c: Candle[]) => atr(c, 100));
const ret1 = memo((c: Candle[]) => logReturnSeries(c));
const rv20 = memo((c: Candle[]) => realizedVol(c, 20));

export function featureCatalog(): FeatureSpec[] {
  const specs: FeatureSpec[] = [];
  const add = (name: string, group: FeatureGroup, note: string, compute: (c: Candle[]) => Series): void => {
    specs.push({ name, group, note, compute });
  };

  // ---- trend -------------------------------------------------------------
  add("ema_dist_20", "trend", "(close - EMA20) / ATR14", (c) => distanceInAtr(c, ema(closes(c), 20), 14));
  add("ema_dist_50", "trend", "(close - EMA50) / ATR14", (c) => distanceInAtr(c, ema(closes(c), 50), 14));
  add("ema_dist_200", "trend", "(close - EMA200) / ATR14", (c) => distanceInAtr(c, ema(closes(c), 200), 14));
  add("ema_cross_20_50", "trend", "(EMA20 - EMA50) / ATR14", (c) =>
    ratio(diff(ema(closes(c), 20), ema(closes(c), 50)), atr14(c)),
  );
  add("ema_slope_50", "trend", "EMA50 change over 10 bars / ATR14", (c) => {
    const e = ema(closes(c), 50);
    const out = empty(c.length);
    const a = atr14(c);
    for (let i = 10; i < c.length; i++) {
      const cur = e[i];
      const prev = e[i - 10];
      const v = a[i];
      if (cur === null || prev === null || v === null || !(v > 0)) continue;
      out[i] = (cur - prev) / v;
    }
    return out;
  });
  add("adx_14", "trend", "ADX level — trend strength, no direction", (c) => adx(c, 14).adx);
  add("dmi_diff_14", "trend", "(+DI - -DI) / (+DI + -DI)", (c) => {
    const r = adx(c, 14);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const p = r.plusDi[i];
      const m = r.minusDi[i];
      if (p === null || m === null || p + m === 0) continue;
      out[i] = (p - m) / (p + m);
    }
    return out;
  });
  add("aroon_osc_25", "trend", "Aroon up minus Aroon down", (c) => aroon(c, 25).oscillator);
  add("vortex_diff_14", "trend", "VI+ minus VI-", (c) => vortex(c, 14).diff);
  add("supertrend_dir_10", "trend", "Supertrend direction, +1 / -1", (c) => supertrend(c, 10, 3).direction);
  add("sar_dist", "trend", "(close - parabolic SAR) / ATR14", (c) => {
    const s = parabolicSar(c);
    return distanceInAtr(c, s.sar, 14);
  });
  add("ichimoku_kijun_dist", "trend", "(close - Kijun) / ATR14", (c) => distanceInAtr(c, ichimoku(c).kijun, 14));
  add("ichimoku_tenkan_kijun", "trend", "(Tenkan - Kijun) / ATR14", (c) => {
    const r = ichimoku(c);
    return ratio(diff(r.tenkan, r.kijun), atr14(c));
  });
  add("ichimoku_cloud_dist", "trend", "signed distance to the displaced cloud / ATR14, 0 inside", (c) => {
    const r = ichimoku(c);
    const a = atr14(c);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const top = r.cloudTop[i];
      const bottom = r.cloudBottom[i];
      const v = a[i];
      if (top === null || bottom === null || v === null || !(v > 0)) continue;
      const close = c[i].close;
      const d = close > top ? close - top : close < bottom ? close - bottom : 0;
      out[i] = d / v;
    }
    return out;
  });
  add("trix_15", "trend", "TRIX, percent change of a triple EMA", (c) => trix(closes(c), 15));
  add("macd_hist_norm", "trend", "MACD histogram / ATR14", (c) => ratio(macd(closes(c), 12, 26, 9).histogram, atr14(c)));
  add("efficiency_ratio_20", "trend", "Kaufman efficiency ratio over 20 bars", (c) => efficiencyRatio(closes(c), 20));
  add("hurst_128", "trend", "rolling Hurst exponent, window 128", (c) => hurstExponent(closes(c), 128));
  add("choppiness_14", "trend", "Choppiness Index — 100 is pure chop", (c) => choppiness(c, 14));
  add("donchian_pos_20", "trend", "position of close inside the 20-bar Donchian channel", (c) => {
    const d = donchian(c, 20);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const u = d.upper[i];
      const l = d.lower[i];
      if (u === null || l === null || !(u > l)) continue;
      out[i] = (c[i].close - l) / (u - l);
    }
    return out;
  });
  add("donchian_pos_55", "trend", "same over 55 bars", (c) => {
    const d = donchian(c, 55);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const u = d.upper[i];
      const l = d.lower[i];
      if (u === null || l === null || !(u > l)) continue;
      out[i] = (c[i].close - l) / (u - l);
    }
    return out;
  });
  add("keltner_pos_20", "trend", "(close - Keltner mid) / half width", (c) => {
    const k = keltner(c, 20, 20, 2);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const m = k.mid[i];
      const u = k.upper[i];
      if (m === null || u === null || !(u > m)) continue;
      out[i] = (c[i].close - m) / (u - m);
    }
    return out;
  });
  add("elder_bull_13", "trend", "(high - EMA13) / ATR14", (c) => ratio(elderRay(c, 13).bull, atr14(c)));
  add("elder_bear_13", "trend", "(low - EMA13) / ATR14", (c) => ratio(elderRay(c, 13).bear, atr14(c)));

  // ---- momentum and mean reversion ---------------------------------------
  add("rsi_14", "momentum", "Wilder RSI, 14", (c) => rsi(closes(c), 14));
  add("rsi_2", "momentum", "Wilder RSI, 2 — the short mean-reversion classic", (c) => rsi(closes(c), 2));
  add("stoch_k_14", "momentum", "Stochastic %K, 14", (c) => stochastic(c, 14, 3).k);
  add("williams_r_28", "momentum", "Williams %R, 28", (c) => williamsR(c, 28));
  add("cci_20", "momentum", "Commodity Channel Index, 20", (c) => cci(c, 20));
  add("roc_10", "momentum", "10-bar rate of change, percent", (c) => {
    const cl = closes(c);
    const out = empty(c.length);
    for (let i = 10; i < c.length; i++) if (cl[i - 10] > 0) out[i] = (cl[i] / cl[i - 10] - 1) * 100;
    return out;
  });
  add("ret_1_norm", "meanReversion", "last bar return / realised vol 20", (c) => ratio(ret1(c), rv20(c)));
  add("ret_4_norm", "meanReversion", "4-bar return / (realised vol 20 * 2)", (c) => {
    const cl = closes(c);
    const v = rv20(c);
    const out = empty(c.length);
    for (let i = 4; i < c.length; i++) {
      const s = v[i];
      if (s === null || !(s > 0) || !(cl[i - 4] > 0)) continue;
      out[i] = Math.log(cl[i] / cl[i - 4]) / (s * 2);
    }
    return out;
  });
  add("ret_24_norm", "meanReversion", "24-bar return / (realised vol 20 * sqrt 24)", (c) => {
    const cl = closes(c);
    const v = rv20(c);
    const k = Math.sqrt(24);
    const out = empty(c.length);
    for (let i = 24; i < c.length; i++) {
      const s = v[i];
      if (s === null || !(s > 0) || !(cl[i - 24] > 0)) continue;
      out[i] = Math.log(cl[i] / cl[i - 24]) / (s * k);
    }
    return out;
  });
  add("awesome_osc", "momentum", "Awesome Oscillator / ATR14", (c) => ratio(awesomeOscillator(c), atr14(c)));
  add("ultimate_osc", "momentum", "Ultimate Oscillator 7/14/28", (c) => ultimateOscillator(c));
  add("run_length", "meanReversion", "signed length of the current streak of same-direction closes", (c) =>
    signedRunLength(c),
  );
  add("zscore_close_20", "meanReversion", "(close - SMA20) / stdev20", (c) => {
    const cl = closes(c);
    const m = sma(cl, 20);
    const s = stdev(cl, 20);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const a = m[i];
      const b = s[i];
      if (a === null || b === null || !(b > 0)) continue;
      out[i] = (cl[i] - a) / b;
    }
    return out;
  });
  add("percent_b_20", "meanReversion", "Bollinger %b, 20 / 2", (c) => percentB(closes(c), 20, 2));

  // ---- volume ------------------------------------------------------------
  add("mfi_14", "volume", "Money Flow Index, 14", (c) => moneyFlowIndex(c, 14));
  add("cmf_20", "volume", "Chaikin Money Flow, 20", (c) => chaikinMoneyFlow(c, 20));
  add("obv_slope_20", "volume", "OBV change over 20 bars / volume traded in those bars", (c) => {
    const o = obv(c);
    const vol = rollingSum(c.map((x) => x.volume), 20);
    const out = empty(c.length);
    for (let i = 20; i < c.length; i++) {
      const v = vol[i];
      if (v === null || !(v > 0)) continue;
      out[i] = (o[i] - o[i - 20]) / v;
    }
    return out;
  });
  add("volume_z_96", "volume", "z-score of log volume against the last 96 bars", (c) =>
    rollingZScore(logSeries(fromNumbers(c.map((x) => x.volume))), 96),
  );
  add("volume_ratio_5_50", "volume", "mean volume over 5 bars / mean over 50", (c) => {
    const vol = c.map((x) => x.volume);
    return ratio(sma(vol, 5), sma(vol, 50));
  });
  add("volume_imbalance_10", "volume", "volume signed by close location, 10 bars", (c) => volumeImbalance(c, 10));
  add("vwap_dev", "volume", "(close - session VWAP) / ATR14", (c) => distanceInAtr(c, vwap(c), 14));
  add("vwap_dev_rolling_50", "volume", "(close - 50-bar rolling VWAP) / ATR14", (c) =>
    distanceInAtr(c, vwap(c, { mode: "rolling", period: 50 }), 14),
  );
  add("amihud_z_100", "volume", "z-score of log Amihud illiquidity, window 100", (c) =>
    rollingZScore(logSeries(amihudIlliquidity(c, 20)), 100),
  );
  add("tick_price_gap", "volume", "typical price minus close, in ATR14", (c) => {
    const a = atr14(c);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const v = a[i];
      if (v === null || !(v > 0)) continue;
      out[i] = (typicalPrice(c[i]) - c[i].close) / v;
    }
    return out;
  });

  // ---- volatility --------------------------------------------------------
  add("atr_ratio_14_100", "volatility", "ATR14 / ATR100 — is the market speeding up", (c) =>
    ratio(atr14(c), atr100(c)),
  );
  add("bb_width_20", "volatility", "Bollinger width / mid", (c) => {
    const b = bollinger(closes(c), 20, 2);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const u = b.upper[i];
      const l = b.lower[i];
      const m = b.mid[i];
      if (u === null || l === null || m === null || !(m > 0)) continue;
      out[i] = (u - l) / m;
    }
    return out;
  });
  add("realized_vol_z_100", "volatility", "z-score of log realised vol 20, window 100", (c) =>
    rollingZScore(logSeries(rv20(c)), 100),
  );
  add("parkinson_over_realized", "volatility", "Parkinson vol / close-to-close vol, 20", (c) => rangeToRealized(c, 20));
  add("gk_over_parkinson", "volatility", "Garman-Klass / Parkinson, 20", (c) =>
    ratio(garmanKlassVol(c, 20), parkinsonVol(c, 20)),
  );
  add("vol_of_vol_50", "volatility", "stdev of log realised vol over 50 bars", (c) => {
    const lv = logSeries(rv20(c));
    const out = empty(c.length);
    for (let i = 49; i < c.length; i++) {
      let sum = 0;
      let sq = 0;
      let n = 0;
      for (let j = i - 49; j <= i; j++) {
        const v = lv[j];
        if (v === null) continue;
        sum += v;
        sq += v * v;
        n++;
      }
      if (n < 10) continue;
      const m = sum / n;
      const variance = sq / n - m * m;
      if (!(variance > 0)) continue;
      out[i] = Math.sqrt(variance);
    }
    return out;
  });
  add("ret_skew_50", "volatility", "skewness of the last 50 bar returns", (c) => rollingSkew(ret1(c), 50));
  add("ret_kurt_50", "volatility", "excess kurtosis of the last 50 bar returns", (c) => rollingKurtosis(ret1(c), 50));
  add("range_over_atr", "volatility", "(high - low) of this bar / ATR14", (c) => {
    const a = atr14(c);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const v = a[i];
      if (v === null || !(v > 0)) continue;
      out[i] = (c[i].high - c[i].low) / v;
    }
    return out;
  });

  // ---- bar shape ---------------------------------------------------------
  add("body_ratio", "shape", "|close - open| / (high - low)", (c) => bodyRatio(c));
  add("close_position", "shape", "where the close sat inside the bar, 0..1", (c) => closePosition(c));
  add("upper_wick", "shape", "share of the range above the body", (c) => upperWick(c));
  add("lower_wick", "shape", "share of the range below the body", (c) => lowerWick(c));
  add("gap_norm", "shape", "(open - previous close) / ATR14", (c) => {
    const g = gapRatio(c);
    const a = atr14(c);
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const v = g[i];
      const t = a[i];
      if (v === null || t === null || !(t > 0)) continue;
      out[i] = (v * c[i].close) / t;
    }
    return out;
  });
  add("body_direction", "shape", "signed body / (high - low)", (c) => {
    const out = empty(c.length);
    for (let i = 0; i < c.length; i++) {
      const range = c[i].high - c[i].low;
      if (!(range > 0)) continue;
      out[i] = (c[i].close - c[i].open) / range;
    }
    return out;
  });

  return specs;
}

export type RegimeKind = "volatility" | "trend" | "session" | "range";

export interface RegimeSpec {
  name: RegimeKind;
  labels: string[];
  /** Regime index per bar, -1 where undefined. */
  compute(candles: Candle[]): Int32Array;
}

/**
 * Regimes the features are conditioned on.
 *
 * These are not screened as signals themselves. They exist to answer the
 * question the linear study could not: whether a feature that looks dead on
 * average is alive in one corner of the market.
 */
export function regimeCatalog(): RegimeSpec[] {
  const terciles = (values: Series): Int32Array => {
    const n = values.length;
    const out = new Int32Array(n).fill(-1);
    const finite: number[] = [];
    for (const v of values) if (v !== null && Number.isFinite(v)) finite.push(v);
    if (finite.length < 30) return out;
    finite.sort((a, b) => a - b);
    const lo = finite[Math.floor(finite.length / 3)];
    const hi = finite[Math.floor((2 * finite.length) / 3)];
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) continue;
      out[i] = v <= lo ? 0 : v <= hi ? 1 : 2;
    }
    return out;
  };

  return [
    {
      name: "volatility",
      labels: ["vol low", "vol mid", "vol high"],
      compute: (c) => terciles(ratio(atr(c, 14), atr(c, 100))),
    },
    {
      name: "trend",
      labels: ["below EMA200", "above EMA200"],
      compute: (c) => {
        const e = ema(closes(c), 200);
        const out = new Int32Array(c.length).fill(-1);
        for (let i = 0; i < c.length; i++) {
          const v = e[i];
          if (v === null) continue;
          out[i] = c[i].close >= v ? 1 : 0;
        }
        return out;
      },
    },
    {
      name: "range",
      labels: ["choppy", "mid", "trending"],
      compute: (c) => {
        const ch = choppiness(c, 14);
        // Reversed so index 2 always means "more trending".
        const t = terciles(ch);
        const out = new Int32Array(c.length).fill(-1);
        for (let i = 0; i < t.length; i++) out[i] = t[i] < 0 ? -1 : 2 - t[i];
        return out;
      },
    },
    {
      name: "session",
      labels: ["00-06 UTC", "06-12 UTC", "12-18 UTC", "18-24 UTC"],
      compute: (c) => {
        const out = new Int32Array(c.length).fill(-1);
        for (let i = 0; i < c.length; i++) out[i] = Math.floor((Math.floor(c[i].time / 3600) % 24) / 6);
        return out;
      },
    },
  ];
}
