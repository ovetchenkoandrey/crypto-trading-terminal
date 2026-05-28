// Stub for future implementation using lightweight-charts v5 `IPanePrimitive` /
// `addPrimitive()` APIs. Native canvas → no React re-renders on pan/zoom and
// proper z-order with other chart layers.
//
// To migrate:
// 1. For each drawing kind, implement a class that exposes `paneViews()` returning
//    objects with `renderer()` → `IPrimitivePaneRenderer` (draws on the chart's
//    own canvas via the bitmap context).
// 2. Manage add / remove / update by calling `chart.attachPrimitive(prim)` and
//    `chart.detachPrimitive(prim)`.
// 3. Hit-testing: implement `hitTest(x, y)` in your pane view if you want clicks.
//
// Keep the same IDrawingRenderer interface — the rest of the app stays unchanged.

import type { Drawing, DrawingTool } from "../types";
import type { DrawingRendererCallbacks, DrawingRendererContext, IDrawingRenderer } from "./IDrawingRenderer";

export class PrimitiveDrawingRenderer implements IDrawingRenderer {
  // The future implementation will hold per-drawing primitive instances here.
  // private primitives = new Map<string, IPanePrimitive<Time>>();

  constructor(_ctx: DrawingRendererContext, _callbacks: DrawingRendererCallbacks) {
    void _ctx; void _callbacks;
    throw new Error("PrimitiveDrawingRenderer is not implemented yet — use the SVG renderer.");
  }

  setDrawings(_drawings: Drawing[]): void { void _drawings; }
  setActiveTool(_tool: DrawingTool): void { void _tool; }
  setSelected(_id: string | null): void { void _id; }
  destroy(): void { /* noop */ }
}
