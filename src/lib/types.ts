export interface Candle {
  time: number;   // UTC seconds — compatible with lightweight-charts
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval =
  | "1" | "3" | "5" | "15" | "30"
  | "60" | "120" | "240" | "360" | "720"
  | "D" | "W" | "M";
