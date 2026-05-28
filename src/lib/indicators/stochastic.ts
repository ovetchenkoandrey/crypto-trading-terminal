import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";

export const def: IndicatorDef = {
  kind: "stochastic",
  name: "Stochastic",
  region: "pane",
  defaultParams: { kPeriod: 14, dPeriod: 3 },
  defaultColor: "#bb86fc",
  compute(candles: Candle[], params): IndicatorOutput {
    const kPeriod = Number(params.kPeriod ?? 14);
    const dPeriod = Number(params.dPeriod ?? 3);

    const kLine: { time: number; value: number }[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < kPeriod - 1) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        if (candles[j].high > hi) hi = candles[j].high;
        if (candles[j].low  < lo) lo = candles[j].low;
      }
      const k = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
      kLine.push({ time: candles[i].time, value: k });
    }

    // %D = SMA(%K, dPeriod)
    const dLine: { time: number; value: number }[] = [];
    for (let i = dPeriod - 1; i < kLine.length; i++) {
      let sum = 0;
      for (let j = i - dPeriod + 1; j <= i; j++) sum += kLine[j].value;
      dLine.push({ time: kLine[i].time, value: sum / dPeriod });
    }

    const color = typeof params.color === "string" ? params.color : this.defaultColor;
    return {
      lines: [
        { name: "%K", color, data: kLine, paneRelativeMin: 0, paneRelativeMax: 100 },
        { name: "%D", color: "#26a69a", data: dLine },
      ],
    };
  },
};
