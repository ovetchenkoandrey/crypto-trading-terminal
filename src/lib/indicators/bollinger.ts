import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";

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

    const middle: { time: number; value: number }[] = [];
    const upper: { time: number; value: number }[] = [];
    const lower: { time: number; value: number }[] = [];

    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
      const sma = sum / period;

      let variance = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const diff = candles[j].close - sma;
        variance += diff * diff;
      }
      const sd = Math.sqrt(variance / period);
      const t = candles[i].time;

      middle.push({ time: t, value: sma });
      upper.push({ time: t, value: sma + mult * sd });
      lower.push({ time: t, value: sma - mult * sd });
    }

    return {
      lines: [
        { name: `BB Mid(${period})`, color, data: middle },
        { name: `BB Up(${period})`, color: color + "aa", data: upper },
        { name: `BB Lo(${period})`, color: color + "aa", data: lower },
      ],
    };
  },
};
