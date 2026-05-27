import type { Candle } from "../types";

export type IndicatorKind = "sma" | "ema" | "rsi" | "macd" | "bollinger";
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

export interface IndicatorOutput {
  lines: IndicatorLine[];
  histogram?: { time: number; value: number; color?: string }[];
}
