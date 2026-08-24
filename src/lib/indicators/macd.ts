import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { toLinePoints } from "./base";
import { closes, macd } from "./core";

export const def: IndicatorDef = {
  kind: "macd",
  name: "MACD",
  region: "pane",
  defaultParams: { fast: 12, slow: 26, signal: 9 },
  defaultColor: "#58a6ff",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const fast = Number(params.fast) || 12;
    const slow = Number(params.slow) || 26;
    const signalPeriod = Number(params.signal) || 9;
    const color = params.color as string || def.defaultColor;

    const res = macd(closes(candles), fast, slow, signalPeriod);

    const histogram: { time: number; value: number; color?: string }[] = [];
    for (let i = 0; i < candles.length; i++) {
      const h = res.histogram[i];
      if (h === null) continue;
      histogram.push({ time: candles[i].time, value: h, color: h >= 0 ? "#26a69a99" : "#ef535099" });
    }

    return {
      lines: [
        { name: "MACD", color, data: toLinePoints(candles, res.macd) },
        { name: "Signal", color: "#f0b90b", data: toLinePoints(candles, res.signal) },
      ],
      histogram,
    };
  },
};
