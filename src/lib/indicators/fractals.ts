// Bill Williams Fractals.
//
// A bullish (down-pointing) fractal forms at bar i if low[i] is strictly lower
// than the lows of the N bars on each side (default N = 2).
// A bearish (up-pointing) fractal mirrors the same on highs.
//
// Standard period is N = 2 (5-bar window). Larger N makes fractals rarer / more
// reliable.

import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput, IndicatorMarker } from "./base";

export const def: IndicatorDef = {
  kind: "fractals",
  name: "Fractals",
  region: "overlay",
  defaultParams: { period: 2 },
  defaultColor: "#f0b90b",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const N = Math.max(1, Math.min(10, Math.floor(Number(params.period) || 2)));
    const color = (params.color as string) || def.defaultColor;
    const markers: IndicatorMarker[] = [];

    // For each bar that has N neighbors on each side, check fractal conditions.
    for (let i = N; i < candles.length - N; i++) {
      const c = candles[i];
      let isHigh = true;
      let isLow  = true;
      for (let j = 1; j <= N; j++) {
        if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false;
        if (candles[i - j].low  <= c.low  || candles[i + j].low  <= c.low ) isLow  = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) {
        markers.push({
          time: c.time,
          position: "aboveBar",
          shape: "arrowDown",
          color,
          size: 1,
        });
      }
      if (isLow) {
        markers.push({
          time: c.time,
          position: "belowBar",
          shape: "arrowUp",
          color,
          size: 1,
        });
      }
    }

    return { lines: [], markers };
  },
};
