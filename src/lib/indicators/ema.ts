import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { closes, ema } from "./core";

export function calcEma(candles: Candle[], period: number): (number | null)[] {
  return ema(closes(candles), period);
}

export const def: IndicatorDef = {
  kind: "ema",
  name: "EMA",
  region: "overlay",
  defaultParams: { period: 20 },
  defaultColor: "#58a6ff",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 20;
    const data = toLinePoints(candles, calcEma(candles, period));

    return {
      lines: [{ name: `EMA(${period})`, color: params.color as string || def.defaultColor, data }],
    };
  },
};
