import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";

export function calcEma(candles: Candle[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += candles[i].close;
  result[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    result[i] = candles[i].close * k + (result[i - 1] as number) * (1 - k);
  }
  return result;
}

export const def: IndicatorDef = {
  kind: "ema",
  name: "EMA",
  region: "overlay",
  defaultParams: { period: 20 },
  defaultColor: "#58a6ff",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 20;
    const vals = calcEma(candles, period);
    const data = vals
      .map((v, i) => v !== null ? { time: candles[i].time, value: v } : null)
      .filter((x): x is { time: number; value: number } => x !== null);

    return {
      lines: [{ name: `EMA(${period})`, color: params.color as string || def.defaultColor, data }],
    };
  },
};
