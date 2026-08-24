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
import { fractals } from "./core";

export const def: IndicatorDef = {
  kind: "fractals",
  name: "Fractals",
  region: "overlay",
  defaultParams: { period: 2 },
  defaultColor: "#f0b90b",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const N = Math.max(1, Math.min(10, Math.floor(Number(params.period) || 2)));
    const color = (params.color as string) || def.defaultColor;

    const { highs, lows } = fractals(candles, N);
    const highSet = new Set(highs);
    const lowSet = new Set(lows);

    const markers: IndicatorMarker[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (highSet.has(i)) {
        markers.push({ time: candles[i].time, position: "aboveBar", shape: "arrowDown", color, size: 1 });
      }
      if (lowSet.has(i)) {
        markers.push({ time: candles[i].time, position: "belowBar", shape: "arrowUp", color, size: 1 });
      }
    }

    return { lines: [], markers };
  },
};
