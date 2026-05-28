// Drawing data model and the renderer-agnostic types.
// The actual visual rendering lives in lib/drawings/renderer/* — SVG today,
// lightweight-charts Primitives tomorrow.

export type DrawingTool = "cursor" | "hline" | "trendline" | "fib" | "text";

export interface DrawingPoint {
  time: number;     // UTC seconds (same as lightweight-charts Candle.time)
  price: number;
}

interface DrawingBase {
  id: string;
  color: string;
  lineWidth?: number;        // default 1
}

export interface HLineDrawing extends DrawingBase {
  kind: "hline";
  price: number;
}

export interface TrendLineDrawing extends DrawingBase {
  kind: "trendline";
  p1: DrawingPoint;
  p2: DrawingPoint;
}

export interface FibDrawing extends DrawingBase {
  kind: "fib";
  p1: DrawingPoint;
  p2: DrawingPoint;
  // Standard Fibonacci ratios 0..1. Editable in dialog later.
  levels: number[];
}

export interface TextDrawing extends DrawingBase {
  kind: "text";
  point: DrawingPoint;
  text: string;
  fontSize?: number;         // default 11
}

export type Drawing = HLineDrawing | TrendLineDrawing | FibDrawing | TextDrawing;

export const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export function newId(prefix = "dr"): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10);
}
