import type { Candle } from "../types";

export type IndicatorKind = "sma" | "ema" | "rsi" | "macd" | "bollinger" | "stochastic" | "atr" | "fractals";
export type IndicatorRegion = "overlay" | "pane";

export interface IndicatorDef {
  kind: IndicatorKind;
  name: string;
  region: IndicatorRegion;
  defaultParams: Record<string, number | string>;
  defaultColor: string;
  compute(candles: Candle[], params: Record<string, number | string>): IndicatorOutput;
}

export interface IndicatorLine {
  name: string;
  color: string;
  data: { time: number; value: number }[];
  paneRelativeMin?: number;
  paneRelativeMax?: number;
}

/** Marker pinned to a bar — used for arrow-style indicators like fractals or signals. */
export interface IndicatorMarker {
  time: number;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  color: string;
  text?: string;
  size?: number;
}

export interface IndicatorOutput {
  lines: IndicatorLine[];
  histogram?: { time: number; value: number; color?: string }[];
  markers?: IndicatorMarker[];
}

/** Drops the leading `null`s of a core series and pins the rest to bar times. */
export function toLinePoints(candles: Candle[], series: (number | null)[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = series[i];
    if (v !== null && v !== undefined) out.push({ time: candles[i].time, value: v });
  }
  return out;
}
