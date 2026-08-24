import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { stochastic } from "./core";

export const def: IndicatorDef = {
  kind: "stochastic",
  name: "Stochastic",
  region: "pane",
  defaultParams: { kPeriod: 14, dPeriod: 3 },
  defaultColor: "#bb86fc",
  compute(candles: Candle[], params): IndicatorOutput {
    const kPeriod = Number(params.kPeriod ?? 14);
    const dPeriod = Number(params.dPeriod ?? 3);
    const { k, d } = stochastic(candles, kPeriod, dPeriod);

    const color = typeof params.color === "string" ? params.color : this.defaultColor;
    return {
      lines: [
        { name: "%K", color, data: toLinePoints(candles, k), paneRelativeMin: 0, paneRelativeMax: 100 },
        { name: "%D", color: "#26a69a", data: toLinePoints(candles, d) },
      ],
    };
  },
};
