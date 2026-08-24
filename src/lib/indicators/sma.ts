import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { closes, sma } from "./core";

export const def: IndicatorDef = {
  kind: "sma",
  name: "SMA",
  region: "overlay",
  defaultParams: { period: 20 },
  defaultColor: "#f0b90b",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 20;
    const data = toLinePoints(candles, sma(closes(candles), period));

    return {
      lines: [{ name: `SMA(${period})`, color: params.color as string || def.defaultColor, data }],
    };
  },
};
