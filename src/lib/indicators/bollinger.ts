import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { bollinger, closes } from "./core";

export const def: IndicatorDef = {
  kind: "bollinger",
  name: "Bollinger Bands",
  region: "overlay",
  defaultParams: { period: 20, stddev: 2 },
  defaultColor: "#58a6ff",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 20;
    const mult = Number(params.stddev) || 2;
    const color = params.color as string || def.defaultColor;

    const bands = bollinger(closes(candles), period, mult);

    return {
      lines: [
        { name: `BB Mid(${period})`, color, data: toLinePoints(candles, bands.mid) },
        { name: `BB Up(${period})`, color: color + "aa", data: toLinePoints(candles, bands.upper) },
        { name: `BB Lo(${period})`, color: color + "aa", data: toLinePoints(candles, bands.lower) },
      ],
    };
  },
};
