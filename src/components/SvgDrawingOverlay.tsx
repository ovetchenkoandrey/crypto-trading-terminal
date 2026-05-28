import { useEffect, useReducer, useRef, useState } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { Drawing, DrawingPoint, DrawingTool, HLineDrawing, TrendLineDrawing, FibDrawing, TextDrawing } from "../lib/drawings/types";
import { DEFAULT_FIB_LEVELS, newId } from "../lib/drawings/types";
import { chartToPixel, pixelToChart } from "../lib/drawings/renderer/IDrawingRenderer";

interface Props {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  drawings: Drawing[];
  activeTool: DrawingTool;
  selectedId: string | null;
  defaultColor: string;
  onCreate:  (d: Drawing) => void;
  onSelect:  (id: string | null) => void;
  onDelete?: (id: string) => void;
  onToolDone?: () => void;     // call after a drawing is created → switch back to cursor
}

const HIT_DISTANCE = 6;        // px — how close to a line counts as a hit

export function SvgDrawingOverlay({
  chart, series, drawings, activeTool, selectedId, defaultColor,
  onCreate, onSelect, onDelete, onToolDone,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [draftPoint, setDraftPoint] = useState<DrawingPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);

  // Re-render on pan/zoom/resize/crosshair (so SVG positions track the chart)
  useEffect(() => {
    const ts = chart.timeScale();
    const onRangeChange = () => force();
    ts.subscribeVisibleLogicalRangeChange(onRangeChange);
    const ro = new ResizeObserver(() => force());
    if (wrapRef.current) ro.observe(wrapRef.current);
    // Also re-render on crosshair move so the rubber-band preview is smooth
    const onCh = () => force();
    chart.subscribeCrosshairMove(onCh);
    return () => {
      try { ts.unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch { /* noop */ }
      try { chart.unsubscribeCrosshairMove(onCh); } catch { /* noop */ }
      ro.disconnect();
    };
  }, [chart]);

  // Delete-key on selected drawing
  useEffect(() => {
    if (!selectedId || !onDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onDelete(selectedId);
        onSelect(null);
      }
      if (e.key === "Escape") onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, onDelete, onSelect]);

  const ctx = { chart, series };

  // ─── pointer handlers ───
  const getPoint = (e: React.PointerEvent | React.MouseEvent): DrawingPoint | null => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return pixelToChart(ctx, rect, e.clientX, e.clientY);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = getPoint(e);
    if (!p) return;

    if (activeTool === "cursor") return;   // selection handled by SVG click below

    if (activeTool === "hline") {
      const d: HLineDrawing = { id: newId(), kind: "hline", price: p.price, color: defaultColor };
      onCreate(d);
      onToolDone?.();
      return;
    }

    if (activeTool === "trendline" || activeTool === "fib") {
      if (!draftPoint) {
        setDraftPoint(p);
        setHoverPoint(p);
      } else {
        const base = { id: newId(), color: defaultColor };
        const d: Drawing = activeTool === "trendline"
          ? { ...base, kind: "trendline" as const, p1: draftPoint, p2: p } satisfies TrendLineDrawing
          : { ...base, kind: "fib"       as const, p1: draftPoint, p2: p, levels: DEFAULT_FIB_LEVELS } satisfies FibDrawing;
        onCreate(d);
        setDraftPoint(null);
        setHoverPoint(null);
        onToolDone?.();
      }
      return;
    }

    if (activeTool === "text") {
      const text = window.prompt("Текст:");
      if (text && text.trim()) {
        const d: TextDrawing = { id: newId(), kind: "text", point: p, text: text.trim(), color: defaultColor };
        onCreate(d);
      }
      onToolDone?.();
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (activeTool === "cursor" || !draftPoint) return;
    const p = getPoint(e);
    if (p) setHoverPoint(p);
  };

  // In cursor mode: overlay div is non-interactive, but individual SVG shapes still
  // catch clicks (they set their own `pointerEvents: stroke`). This way pan/scroll
  // of the chart keeps working when the cursor tool is active.
  const interactive = activeTool !== "cursor";
  const cursorStyle = activeTool === "cursor" ? "default" : "crosshair";

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      style={{
        position: "absolute",
        inset: 0,
        cursor: cursorStyle,
        // When cursor tool is active and nothing selected — let pointer events fall through to the chart
        pointerEvents: interactive ? "auto" : "none",
        zIndex: 5,
      }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {drawings.map((d) => (
          <DrawingShape
            key={d.id}
            ctx={ctx}
            drawing={d}
            selected={d.id === selectedId}
            onClick={() => onSelect(d.id)}
            allowClick={activeTool === "cursor"}
            containerWidth={wrapRef.current?.clientWidth ?? 0}
          />
        ))}
        {draftPoint && hoverPoint && (activeTool === "trendline" || activeTool === "fib") && (
          <DraftPreview ctx={ctx} tool={activeTool} p1={draftPoint} p2={hoverPoint} color={defaultColor} />
        )}
      </svg>
    </div>
  );
}

// ─── individual shape renderers ───

interface ShapeProps {
  ctx: { chart: IChartApi; series: ISeriesApi<"Candlestick"> };
  drawing: Drawing;
  selected: boolean;
  onClick: () => void;
  allowClick: boolean;
  containerWidth: number;
}

function DrawingShape({ ctx, drawing, selected, onClick, allowClick, containerWidth }: ShapeProps) {
  const stroke = drawing.color;
  const sw = (drawing.lineWidth ?? 1) + (selected ? 1 : 0);
  const dash = selected ? "4 2" : undefined;
  // `clickProps` is no longer used — each shape attaches its own hit area below
  // with explicit pointerEvents="stroke" or pointerEvents="all" so transparent
  // SVG shapes can actually receive mouse events.
  void dash;

  if (drawing.kind === "hline") {
    const y = ctx.series.priceToCoordinate(drawing.price);
    if (y === null) return null;
    const yn = y as number;
    const priceText = drawing.price.toFixed(4);
    const labelW = Math.max(48, priceText.length * 7 + 8);
    const labelX = Math.max(0, containerWidth - labelW - 4);
    return (
      <g>
        {/* visible line spanning the chart width */}
        <line x1={0} y1={yn} x2={containerWidth} y2={yn}
              stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
              pointerEvents="none" />
        {/* fat invisible hit area */}
        {allowClick && (
          <line x1={0} y1={yn} x2={containerWidth} y2={yn} stroke="transparent" strokeWidth={HIT_DISTANCE * 2}
                pointerEvents="stroke"
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                style={{ cursor: "pointer" }} />
        )}
        {/* price label on the right side of the chart */}
        <g pointerEvents="none">
          <rect x={labelX} y={yn - 8} width={labelW} height={16}
                fill={stroke} opacity={selected ? 1 : 0.85} rx={2} />
          <text x={labelX + labelW / 2} y={yn + 3} fill="white" fontSize={10}
                fontFamily="monospace" textAnchor="middle" fontWeight={600}>
            {priceText}
          </text>
        </g>
      </g>
    );
  }

  if (drawing.kind === "trendline") {
    const a = chartToPixel(ctx, drawing.p1);
    const b = chartToPixel(ctx, drawing.p2);
    if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
    return (
      <g>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} pointerEvents="none" />
        {/* fat invisible hit area — pointerEvents="stroke" is the magic that makes transparent SVG strokes clickable */}
        {allowClick && (
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={HIT_DISTANCE * 2}
                pointerEvents="stroke"
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                style={{ cursor: "pointer" }} />
        )}
        {selected && (
          <>
            <circle cx={a.x} cy={a.y} r={4} fill={stroke} pointerEvents="none" />
            <circle cx={b.x} cy={b.y} r={4} fill={stroke} pointerEvents="none" />
          </>
        )}
      </g>
    );
  }

  if (drawing.kind === "fib") {
    const a = chartToPixel(ctx, drawing.p1);
    const b = chartToPixel(ctx, drawing.p2);
    if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
    const ax = a.x as number, ay = a.y as number;
    const bx = b.x as number, by = b.y as number;
    const x1 = Math.min(ax, bx);
    const x2 = Math.max(ax, bx);
    return (
      <g>
        {/* visual levels — non-interactive */}
        {drawing.levels.map((lvl) => {
          const y = ay + (by - ay) * lvl;
          const price = drawing.p1.price + (drawing.p2.price - drawing.p1.price) * lvl;
          return (
            <g key={lvl} pointerEvents="none">
              <line x1={x1} y1={y} x2={x2} y2={y} stroke={stroke} strokeWidth={sw} strokeDasharray={selected ? "4 2" : "1 2"} opacity={0.8} />
              <text x={x1 + 4} y={y - 3} fill={stroke} fontSize={9} fontFamily="monospace" opacity={0.9}>
                {(lvl * 100).toFixed(1)}% — {price.toFixed(2)}
              </text>
            </g>
          );
        })}
        {/* main trendline */}
        <line x1={ax} y1={ay} x2={bx} y2={by} stroke={stroke} strokeWidth={sw} opacity={0.6} pointerEvents="none" />
        {/* fat invisible hit area on each level + main line for easy selection */}
        {allowClick && (
          <g onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ cursor: "pointer" }}>
            {drawing.levels.map((lvl) => {
              const y = ay + (by - ay) * lvl;
              return <line key={lvl} x1={x1} y1={y} x2={x2} y2={y} stroke="transparent" strokeWidth={HIT_DISTANCE * 2} pointerEvents="stroke" />;
            })}
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke="transparent" strokeWidth={HIT_DISTANCE * 2} pointerEvents="stroke" />
          </g>
        )}
        {selected && (
          <>
            <circle cx={ax} cy={ay} r={4} fill={stroke} pointerEvents="none" />
            <circle cx={bx} cy={by} r={4} fill={stroke} pointerEvents="none" />
          </>
        )}
      </g>
    );
  }

  if (drawing.kind === "text") {
    const p = chartToPixel(ctx, drawing.point);
    if (p.x === null || p.y === null) return null;
    const fs = drawing.fontSize ?? 12;
    // Approximate the text bounding box so we can put a clickable rect under it.
    const w = Math.max(20, drawing.text.length * fs * 0.65);
    const h = fs * 1.5;
    return (
      <g>
        <text x={p.x} y={p.y} fill={stroke} fontSize={fs} fontFamily='"Segoe UI", sans-serif'
              fontWeight={selected ? 700 : 500}
              pointerEvents="none"
              style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.5)", strokeWidth: 2, strokeLinejoin: "round" }}>
          {drawing.text}
        </text>
        {allowClick && (
          <rect x={(p.x as number) - 2} y={(p.y as number) - h + fs * 0.2} width={w + 4} height={h}
                fill="transparent" pointerEvents="all"
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                style={{ cursor: "pointer" }} />
        )}
        {selected && (
          <rect x={(p.x as number) - 3} y={(p.y as number) - h + fs * 0.2} width={w + 6} height={h}
                fill="none" stroke={stroke} strokeWidth={1} strokeDasharray="3 2" pointerEvents="none" />
        )}
      </g>
    );
  }

  return null;
}

function DraftPreview({ ctx, tool, p1, p2, color }: { ctx: ShapeProps["ctx"]; tool: DrawingTool; p1: DrawingPoint; p2: DrawingPoint; color: string }) {
  const a = chartToPixel(ctx, p1);
  const b = chartToPixel(ctx, p2);
  if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
  const ax = a.x as number, ay = a.y as number;
  const bx = b.x as number, by = b.y as number;
  if (tool === "trendline") {
    return <line x1={ax} y1={ay} x2={bx} y2={by} stroke={color} strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />;
  }
  if (tool === "fib") {
    return (
      <g opacity={0.6}>
        {DEFAULT_FIB_LEVELS.map((lvl) => {
          const y = ay + (by - ay) * lvl;
          return <line key={lvl} x1={ax} y1={y} x2={bx} y2={y} stroke={color} strokeDasharray="2 3" />;
        })}
        <line x1={ax} y1={ay} x2={bx} y2={by} stroke={color} strokeDasharray="2 3" />
      </g>
    );
  }
  return null;
}
