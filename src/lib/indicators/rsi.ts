import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { closes, rsi } from "./core";

export const def: IndicatorDef = {
  kind: "rsi",
  name: "RSI",
  region: "pane",
  defaultParams: { period: 14 },
  defaultColor: "#c792ea",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 14;
    const data = toLinePoints(candles, rsi(closes(candles), period));

    return {
      lines: [{
        name: `RSI(${period})`,
        color: params.color as string || def.defaultColor,
        data,
        paneRelativeMin: 0,
        paneRelativeMax: 100,
      }],
    };
  },
};
