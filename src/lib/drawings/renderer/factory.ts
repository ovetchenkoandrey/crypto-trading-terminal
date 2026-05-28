// Selects the active drawing renderer implementation.
//
// Today: only "svg" is wired (used directly by ChartPane via React).
// Tomorrow: pass a config string here from settings to switch between
// "svg" and "primitive" without touching call sites.

export type DrawingRendererKind = "svg" | "primitive";

export function getActiveRendererKind(): DrawingRendererKind {
  // Future: read from settings. For now SVG only.
  return "svg";
}
