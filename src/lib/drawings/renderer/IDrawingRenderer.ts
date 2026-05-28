import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { Drawing, DrawingPoint } from "../types";

export interface DrawingRendererContext {
  chart: IChartApi;
  // The main price series — used to translate price ↔ pixel coordinates. May be candle / line / area.
  series: ISeriesApi<"Candlestick" | "Line" | "Area">;
}

export interface DrawingRendererCallbacks {
  /** User clicked an existing drawing. */
  onSelect?: (id: string | null) => void;
  /** User finished sketching a new drawing via the active tool. */
  onCreate?: (d: Drawing) => void;
  /** User dragged a drawing handle to a new position. */
  onUpdate?: (id: string, partial: Partial<Drawing>) => void;
  /** User pressed Delete on a selected drawing. */
  onDelete?: (id: string) => void;
}

/**
 * Renderer-agnostic interface for chart drawings.
 *
 * Today we have one implementation: SvgDrawingRenderer.
 * Tomorrow we may add a Primitives-based renderer for tighter integration with
 * lightweight-charts (no React re-renders during pan/zoom). The store and
 * tool-handling logic stay the same.
 */
export interface IDrawingRenderer {
  /** Push the current drawings list. The renderer diffs internally. */
  setDrawings(drawings: Drawing[]): void;
  /** Tell the renderer which tool is currently active (changes cursor / click handlers). */
  setActiveTool(tool: import("../types").DrawingTool): void;
  /** Highlight one drawing (or none). */
  setSelected(id: string | null): void;
  /** Free all DOM/canvas resources. */
  destroy(): void;
}

export type DrawingRendererFactory = (
  container: HTMLElement,
  ctx: DrawingRendererContext,
  callbacks: DrawingRendererCallbacks,
) => IDrawingRenderer;

/** Convert a coordinate on screen (px) into chart space (time, price). */
export function pixelToChart(
  ctx: DrawingRendererContext,
  containerRect: DOMRect,
  clientX: number,
  clientY: number,
): DrawingPoint | null {
  const x = clientX - containerRect.left;
  const y = clientY - containerRect.top;
  const time = ctx.chart.timeScale().coordinateToTime(x);
  const price = ctx.series.coordinateToPrice(y);
  if (time === null || price === null) return null;
  return { time: time as number, price };
}

/** Convert chart space (time, price) into screen pixels (relative to container). */
export function chartToPixel(
  ctx: DrawingRendererContext,
  point: DrawingPoint,
): { x: number | null; y: number | null } {
  const x = ctx.chart.timeScale().timeToCoordinate(point.time as never);
  const y = ctx.series.priceToCoordinate(point.price);
  return { x: x ?? null, y: y ?? null };
}
