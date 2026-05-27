import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";
import { calcEma } from "./ema";

function calcEmaFromValues(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + (result[i - 1] as number) * (1 - k);
  }
  return result;
}

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

    const emaFast = calcEma(candles, fast);
    const emaSlow = calcEma(candles, slow);

    // MACD line: only where both EMAs are defined (i.e., from slow-1 onward)
    const macdValues: (number | null)[] = candles.map((_, i) => {
      const f = emaFast[i];
      const s = emaSlow[i];
      return f !== null && s !== null ? f - s : null;
    });

    // Extract non-null macd values with their indices to compute signal EMA
    const macdNonNull: { idx: number; val: number }[] = [];
    macdValues.forEach((v, i) => { if (v !== null) macdNonNull.push({ idx: i, val: v }); });

    const signalVals = calcEmaFromValues(macdNonNull.map((x) => x.val), signalPeriod);

    const macdLine: { time: number; value: number }[] = [];
    const signalLine: { time: number; value: number }[] = [];
    const histogram: { time: number; value: number; color?: string }[] = [];

    macdNonNull.forEach(({ idx, val }, j) => {
      macdLine.push({ time: candles[idx].time, value: val });
      const sig = signalVals[j];
      if (sig !== null) {
        signalLine.push({ time: candles[idx].time, value: sig });
        const h = val - sig;
        histogram.push({ time: candles[idx].time, value: h, color: h >= 0 ? "#26a69a99" : "#ef535099" });
      }
    });

    return {
      lines: [
        { name: "MACD", color, data: macdLine },
        { name: "Signal", color: "#f0b90b", data: signalLine },
      ],
      histogram,
    };
  },
};
