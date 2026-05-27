import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";

export const def: IndicatorDef = {
  kind: "sma",
  name: "SMA",
  region: "overlay",
  defaultParams: { period: 20 },
  defaultColor: "#f0b90b",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 20;
    const data: { time: number; value: number }[] = [];

    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
      data.push({ time: candles[i].time, value: sum / period });
    }

    return {
      lines: [{ name: `SMA(${period})`, color: params.color as string || def.defaultColor, data }],
    };
  },
};
