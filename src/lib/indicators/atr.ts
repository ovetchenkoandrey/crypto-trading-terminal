import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { atr } from "./core";

export const def: IndicatorDef = {
  kind: "atr",
  name: "ATR",
  region: "pane",
  defaultParams: { period: 14 },
  defaultColor: "#f0b90b",
  compute(candles: Candle[], params): IndicatorOutput {
    const period = Number(params.period ?? 14);
    const color = typeof params.color === "string" ? params.color : this.defaultColor;
    const data = toLinePoints(candles, atr(candles, period));

    return { lines: [{ name: "ATR", color, data }] };
  },
};
