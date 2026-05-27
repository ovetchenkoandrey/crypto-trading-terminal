import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";

export const def: IndicatorDef = {
  kind: "rsi",
  name: "RSI",
  region: "pane",
  defaultParams: { period: 14 },
  defaultColor: "#c792ea",

  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput {
    const period = Number(params.period) || 14;
    const data: { time: number; value: number }[] = [];

    if (candles.length < period + 1) {
      return { lines: [{ name: `RSI(${period})`, color: params.color as string || def.defaultColor, data, paneRelativeMin: 0, paneRelativeMax: 100 }] };
    }

    // Initial avg gain/loss over first period
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff >= 0) avgGain += diff; else avgLoss += -diff;
    }
    avgGain /= period;
    avgLoss /= period;

    const rsiAt = (ag: number, al: number) => al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    data.push({ time: candles[period].time, value: rsiAt(avgGain, avgLoss) });

    for (let i = period + 1; i < candles.length; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      data.push({ time: candles[i].time, value: rsiAt(avgGain, avgLoss) });
    }

    return {
      lines: [{ name: `RSI(${period})`, color: params.color as string || def.defaultColor, data, paneRelativeMin: 0, paneRelativeMax: 100 }],
    };
  },
};
