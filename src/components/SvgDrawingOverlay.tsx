import { useEffect, useReducer, useRef, useState } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type {
  Drawing, DrawingPoint, DrawingTool,
  HLineDrawing, TrendLineDrawing, FibDrawing, TextDrawing,
} from "../lib/drawings/types";
import { DEFAULT_FIB_LEVELS, newId } from "../lib/drawings/types";
import { chartToPixel, pixelToChart } from "../lib/drawings/renderer/IDrawingRenderer";
import type { Candle } from "../lib/types";

interface Props {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  candles: Candle[];           // for snap to OHLC
  drawings: Drawing[];
  activeTool: DrawingTool;
  selectedId: string | null;
  defaultColor: string;
  onCreate:    (d: Drawing) => void;
  onSelect:    (id: string | null) => void;
  onUpdate?:   (id: string, partial: Partial<Drawing>) => void;
  onDelete?:   (id: string) => void;
  onToolDone?: () => void;
  onEdit?:     (id: string) => void;    // opens params dialog
}

const HIT_DISTANCE = 6;
const OHLC_SNAP_PIXELS = 10;     // if cursor within this many px of an O/H/L/C — snap

// ─── helpers ─────────────────────────────────────────────────

/** Find the index of the candle whose time is closest to the given time. */
function findCandleIndex(candles: Candle[], time: number): number {
  if (candles.length === 0) return -1;
  // binary search since candles are time-ascending
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].time < time) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(candles[lo - 1].time - time) < Math.abs(candles[lo].time - time)) return lo - 1;
  return lo;
}

/**
 * Snap a raw chart point to the nearest bar + nearest O/H/L/C if within threshold.
 * Pixel-distance check is done via priceToCoordinate so threshold stays consistent across zoom levels.
 */
function snapPoint(
  point: DrawingPoint,
  candles: Candle[],
  series: ISeriesApi<"Candlestick">,
): DrawingPoint {
  if (candles.length === 0) return point;
  const idx = findCandleIndex(candles, point.time);
  if (idx < 0) return point;
  const candle = candles[idx];

  // Compare cursor y to each OHLC y; pick closest if within threshold
  const cursorY = series.priceToCoordinate(point.price);
  if (cursorY === null) {
    return { time: candle.time, price: point.price };
  }
  let bestPrice = point.price;
  let bestDist = Infinity;
  for (const ohlc of [candle.open, candle.high, candle.low, candle.close]) {
    const y = series.priceToCoordinate(ohlc);
    if (y === null) continue;
    const d = Math.abs((y as number) - (cursorY as number));
    if (d < bestDist) { bestDist = d; bestPrice = ohlc; }
  }
  return {
    time: candle.time,
    price: bestDist <= OHLC_SNAP_PIXELS ? bestPrice : point.price,
  };
}

// ─── state machine ───────────────────────────────────────────

type OverlayState =
  | { mode: "idle" }
  | { mode: "creating"; tool: DrawingTool; p1: DrawingPoint; current: DrawingPoint }
  | { mode: "dragging"; id: string; handle: "p1" | "p2" | "middle" | "single"; snap: boolean; startPoint: DrawingPoint; original: Drawing };

type OverlayAction =
  | { type: "start-create"; tool: DrawingTool; point: DrawingPoint }
  | { type: "move-create";  point: DrawingPoint }
  | { type: "finish-create" }
  | { type: "start-drag"; id: string; handle: "p1" | "p2" | "middle" | "single"; startPoint: DrawingPoint; original: Drawing }
  | { type: "move-drag";  point: DrawingPoint }
  | { type: "finish-drag" }
  | { type: "cancel" };

function reduce(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case "start-create":
      return { mode: "creating", tool: action.tool, p1: action.point, current: action.point };
    case "move-create":
      if (state.mode !== "creating") return state;
      return { ...state, current: action.point };
    case "finish-create":
    case "finish-drag":
    case "cancel":
      return { mode: "idle" };
    case "start-drag":
      return { mode: "dragging", id: action.id, handle: action.handle, snap: true, startPoint: action.startPoint, original: action.original };
    case "move-drag":
      return state;        // pure event — actual update is dispatched as onUpdate
  }
}

// ─── component ───────────────────────────────────────────────

export function SvgDrawingOverlay({
  chart, series, candles, drawings, activeTool, selectedId, defaultColor,
  onCreate, onSelect, onUpdate, onDelete, onToolDone, onEdit,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [state, dispatch] = useReducer(reduce, { mode: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Re-render on pan/zoom/resize/crosshair (so SVG positions track the chart)
  useEffect(() => {
    const ts = chart.timeScale();
    const onRangeChange = () => force();
    ts.subscribeVisibleLogicalRangeChange(onRangeChange);
    const ro = new ResizeObserver(() => force());
    if (wrapRef.current) ro.observe(wrapRef.current);
    const onCh = () => force();
    chart.subscribeCrosshairMove(onCh);
    return () => {
      try { ts.unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch { /* noop */ }
      try { chart.unsubscribeCrosshairMove(onCh); } catch { /* noop */ }
      ro.disconnect();
    };
  }, [chart]);

  // Click on empty chart area (candles / background) deselects the current drawing.
  // Drawings have `pointer-events: stroke` so clicks on them DON'T bubble to the chart canvas —
  // which means subscribeClick fires only when the click missed every drawing.
  useEffect(() => {
    if (!selectedId) return;
    const handler = () => {
      if (stateRef.current.mode === "idle") onSelect(null);
    };
    chart.subscribeClick(handler);
    return () => { try { chart.unsubscribeClick(handler); } catch { /* noop */ } };
  }, [chart, selectedId, onSelect]);

  // Delete-key on selected drawing; Escape cancels create/drag/select
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (stateRef.current.mode !== "idle") dispatch({ type: "cancel" });
        else if (selectedId) onSelect(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && onDelete) {
        e.preventDefault();
        onDelete(selectedId);
        onSelect(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, onDelete, onSelect]);

  // Helper: convert a browser event into a snapped chart point
  const getPoint = (clientX: number, clientY: number, snap = true): DrawingPoint | null => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const p = pixelToChart({ chart, series }, rect, clientX, clientY);
    if (!p) return null;
    return snap ? snapPoint(p, candles, series) : p;
  };

  // Window-level pointer move/up listeners during create or drag, so the user can
  // move the cursor anywhere on the page and we still receive events.
  useEffect(() => {
    if (state.mode === "idle") return;

    const onMove = (e: PointerEvent) => {
      const p = getPoint(e.clientX, e.clientY);
      if (!p) return;
      const s = stateRef.current;
      if (s.mode === "creating") {
        dispatch({ type: "move-create", point: p });
      } else if (s.mode === "dragging" && onUpdate) {
        const orig = s.original;
        if (s.handle === "p1" && "p1" in orig) onUpdate(s.id, { p1: p });
        else if (s.handle === "p2" && "p2" in orig) onUpdate(s.id, { p2: p });
        else if (s.handle === "single") {
          if (orig.kind === "hline") onUpdate(s.id, { price: p.price });
          else if (orig.kind === "text") onUpdate(s.id, { point: p });
        } else if (s.handle === "middle") {
          // shift both endpoints by the delta from startPoint→cursor
          const dt = p.time - s.startPoint.time;
          const dp = p.price - s.startPoint.price;
          if (orig.kind === "trendline" || orig.kind === "fib") {
            onUpdate(s.id, {
              p1: { time: orig.p1.time + dt, price: orig.p1.price + dp },
              p2: { time: orig.p2.time + dt, price: orig.p2.price + dp },
            });
          } else if (orig.kind === "hline") {
            onUpdate(s.id, { price: orig.price + dp });
          } else if (orig.kind === "text") {
            onUpdate(s.id, { point: { time: orig.point.time + dt, price: orig.point.price + dp } });
          }
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      const p = getPoint(e.clientX, e.clientY);
      const s = stateRef.current;
      if (s.mode === "creating" && p) {
        finishCreate(s.tool, s.p1, p);
      }
      dispatch({ type: "finish-create" });   // also resets dragging
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.mode, onUpdate]);

  // Helper to commit a newly created drawing
  const finishCreate = (tool: DrawingTool, p1: DrawingPoint, p2: DrawingPoint) => {
    const base = { id: newId(), color: defaultColor };
    if (tool === "hline") {
      const d: HLineDrawing = { ...base, kind: "hline", price: p2.price };
      onCreate(d);
    } else if (tool === "trendline") {
      // If user just clicked without dragging, p1 ≈ p2 — make a sensible default span (1 bar)
      const d: TrendLineDrawing = { ...base, kind: "trendline", p1, p2 };
      onCreate(d);
    } else if (tool === "fib") {
      const d: FibDrawing = { ...base, kind: "fib", p1, p2, levels: DEFAULT_FIB_LEVELS };
      onCreate(d);
    } else if (tool === "text") {
      const text = window.prompt("Текст:");
      if (text && text.trim()) {
        const d: TextDrawing = { ...base, kind: "text", point: p2, text: text.trim() };
        onCreate(d);
      }
    }
    onToolDone?.();
  };

  // ─── pointer handlers on the overlay (for create + clicks on empty space) ───
  const onPointerDown = (e: React.PointerEvent) => {
    if (activeTool === "cursor") {
      // click on empty space deselects
      onSelect(null);
      return;
    }
    const p = getPoint(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dispatch({ type: "start-create", tool: activeTool, point: p });
  };

  // Pointer events on drawings (clicks/drags on existing handles + bodies)
  const startHandleDrag = (id: string, handle: "p1" | "p2" | "middle" | "single", e: React.PointerEvent) => {
    if (activeTool !== "cursor" || !onUpdate) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const start = getPoint(e.clientX, e.clientY, false);
    if (!start) return;
    const original = drawings.find((d) => d.id === id);
    if (!original) return;
    onSelect(id);
    dispatch({ type: "start-drag", id, handle, startPoint: start, original });
  };

  const interactive = activeTool !== "cursor" || state.mode !== "idle";
  const cursorStyle = activeTool === "cursor" ? (state.mode === "dragging" ? "grabbing" : "default") : "crosshair";

  // Preview of the drawing being created
  const previewDrawing: Drawing | null = state.mode === "creating"
    ? buildPreview(state.tool, state.p1, state.current, defaultColor)
    : null;

  const containerWidth = wrapRef.current?.clientWidth ?? 0;

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        inset: 0,
        cursor: cursorStyle,
        pointerEvents: interactive ? "auto" : "none",
        zIndex: 5,
      }}
    >
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {drawings.map((d) => (
          <DrawingShape
            key={d.id}
            ctx={{ chart, series }}
            drawing={d}
            selected={d.id === selectedId}
            allowClick={activeTool === "cursor"}
            containerWidth={containerWidth}
            onClick={() => onSelect(d.id)}
            onDoubleClick={() => onEdit?.(d.id)}
            onHandleDown={(handle, e) => startHandleDrag(d.id, handle, e)}
          />
        ))}
        {previewDrawing && (
          <DrawingShape
            ctx={{ chart, series }}
            drawing={previewDrawing}
            selected={false}
            allowClick={false}
            containerWidth={containerWidth}
            isPreview
            onClick={() => {}}
            onDoubleClick={() => {}}
            onHandleDown={() => {}}
          />
        )}
      </svg>
    </div>
  );
}

// ─── preview builder ─────────────────────────────────────────

function buildPreview(tool: DrawingTool, p1: DrawingPoint, p2: DrawingPoint, color: string): Drawing | null {
  const base = { id: "__preview__", color };
  switch (tool) {
    case "hline":     return { ...base, kind: "hline", price: p2.price } satisfies HLineDrawing;
    case "trendline": return { ...base, kind: "trendline", p1, p2 } satisfies TrendLineDrawing;
    case "fib":       return { ...base, kind: "fib", p1, p2, levels: DEFAULT_FIB_LEVELS } satisfies FibDrawing;
    case "text":      return { ...base, kind: "text", point: p2, text: "…" } satisfies TextDrawing;
    default:          return null;
  }
}

// ─── individual shape renderer with handles ──────────────────

interface ShapeProps {
  ctx: { chart: IChartApi; series: ISeriesApi<"Candlestick"> };
  drawing: Drawing;
  selected: boolean;
  allowClick: boolean;
  containerWidth: number;
  isPreview?: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onHandleDown: (handle: "p1" | "p2" | "middle" | "single", e: React.PointerEvent) => void;
}

function DrawingShape({
  ctx, drawing, selected, allowClick, containerWidth, isPreview,
  onClick, onDoubleClick, onHandleDown,
}: ShapeProps) {
  const stroke = drawing.color;
  const sw = (drawing.lineWidth ?? 1) + (selected ? 1 : 0);
  const dash = isPreview ? "3 3" : selected ? "4 2" : undefined;
  const opacity = isPreview ? 0.6 : 1;

  const clickable = allowClick && !isPreview;
  const bodyHandlers = clickable ? {
    onClick:       (e: React.MouseEvent) => { e.stopPropagation(); onClick(); },
    onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); onDoubleClick(); },
  } : {};

  if (drawing.kind === "hline") {
    const y = ctx.series.priceToCoordinate(drawing.price);
    if (y === null) return null;
    const yn = y as number;
    const priceText = drawing.price.toFixed(4);
    const labelW = Math.max(48, priceText.length * 7 + 8);
    const labelX = Math.max(0, containerWidth - labelW - 4);
    return (
      <g opacity={opacity}>
        <line x1={0} y1={yn} x2={containerWidth} y2={yn}
              stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
              pointerEvents="none" />
        {clickable && (
          <line x1={0} y1={yn} x2={containerWidth} y2={yn}
                stroke="transparent" strokeWidth={HIT_DISTANCE * 2}
                pointerEvents="stroke"
                {...bodyHandlers}
                onPointerDown={(e) => onHandleDown("middle", e)}
                style={{ cursor: selected ? "grab" : "pointer" }} />
        )}
        {/* price label on the right edge */}
        <g pointerEvents="none">
          <rect x={labelX} y={yn - 8} width={labelW} height={16}
                fill={stroke} opacity={selected ? 1 : 0.85} rx={2} />
          <text x={labelX + labelW / 2} y={yn + 3} fill="white" fontSize={10}
                fontFamily="monospace" textAnchor="middle" fontWeight={600}>
            {priceText}
          </text>
        </g>
        {selected && !isPreview && (
          <circle cx={containerWidth / 2} cy={yn} r={5}
                  fill={stroke} stroke="white" strokeWidth={1}
                  pointerEvents="all"
                  onPointerDown={(e) => { e.stopPropagation(); onHandleDown("single", e); }}
                  style={{ cursor: "grab" }} />
        )}
      </g>
    );
  }

  if (drawing.kind === "trendline") {
    const a = chartToPixel(ctx, drawing.p1);
    const b = chartToPixel(ctx, drawing.p2);
    if (a.x === null || a.y === null || b.x === null || b.y === null) return null;
    const ax = a.x as number, ay = a.y as number;
    const bx = b.x as number, by = b.y as number;
    return (
      <g opacity={opacity}>
        <line x1={ax} y1={ay} x2={bx} y2={by}
              stroke={stroke} strokeWidth={sw} strokeDasharray={dash}
              pointerEvents="none" />
        {clickable && (
          <line x1={ax} y1={ay} x2={bx} y2={by}
                stroke="transparent" strokeWidth={HIT_DISTANCE * 2}
                pointerEvents="stroke"
                {...bodyHandlers}
                onPointerDown={(e) => onHandleDown("middle", e)}
                style={{ cursor: selected ? "grab" : "pointer" }} />
        )}
        {selected && !isPreview && (
          <>
            <circle cx={ax} cy={ay} r={5} fill={stroke} stroke="white" strokeWidth={1}
                    pointerEvents="all"
                    onPointerDown={(e) => { e.stopPropagation(); onHandleDown("p1", e); }}
                    style={{ cursor: "grab" }} />
            <circle cx={bx} cy={by} r={5} fill={stroke} stroke="white" strokeWidth={1}
                    pointerEvents="all"
                    onPointerDown={(e) => { e.stopPropagation(); onHandleDown("p2", e); }}
                    style={{ cursor: "grab" }} />
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
      <g opacity={opacity}>
        {drawing.levels.map((lvl) => {
          const yLvl = ay + (by - ay) * lvl;
          const price = drawing.p1.price + (drawing.p2.price - drawing.p1.price) * lvl;
          return (
            <g key={lvl} pointerEvents="none">
              <line x1={x1} y1={yLvl} x2={x2} y2={yLvl}
                    stroke={stroke} strokeWidth={sw}
                    strokeDasharray={selected ? "4 2" : "1 2"} opacity={0.8} />
              <text x={x1 + 4} y={yLvl - 3} fill={stroke}
                    fontSize={9} fontFamily="monospace" opacity={0.9}>
                {(lvl * 100).toFixed(1)}% — {price.toFixed(2)}
              </text>
            </g>
          );
        })}
        <line x1={ax} y1={ay} x2={bx} y2={by}
              stroke={stroke} strokeWidth={sw} opacity={0.6} pointerEvents="none" />
        {clickable && (
          <g {...bodyHandlers}
             onPointerDown={(e) => onHandleDown("middle", e)}
             style={{ cursor: selected ? "grab" : "pointer" }}>
            {drawing.levels.map((lvl) => {
              const yLvl = ay + (by - ay) * lvl;
              return <line key={lvl} x1={x1} y1={yLvl} x2={x2} y2={yLvl}
                           stroke="transparent" strokeWidth={HIT_DISTANCE * 2}
                           pointerEvents="stroke" />;
            })}
            <line x1={ax} y1={ay} x2={bx} y2={by}
                  stroke="transparent" strokeWidth={HIT_DISTANCE * 2}
                  pointerEvents="stroke" />
          </g>
        )}
        {selected && !isPreview && (
          <>
            <circle cx={ax} cy={ay} r={5} fill={stroke} stroke="white" strokeWidth={1}
                    pointerEvents="all"
                    onPointerDown={(e) => { e.stopPropagation(); onHandleDown("p1", e); }}
                    style={{ cursor: "grab" }} />
            <circle cx={bx} cy={by} r={5} fill={stroke} stroke="white" strokeWidth={1}
                    pointerEvents="all"
                    onPointerDown={(e) => { e.stopPropagation(); onHandleDown("p2", e); }}
                    style={{ cursor: "grab" }} />
          </>
        )}
      </g>
    );
  }

  if (drawing.kind === "text") {
    const p = chartToPixel(ctx, drawing.point);
    if (p.x === null || p.y === null) return null;
    const fs = drawing.fontSize ?? 12;
    const w = Math.max(20, drawing.text.length * fs * 0.65);
    const h = fs * 1.5;
    const px = p.x as number, py = p.y as number;
    return (
      <g opacity={opacity}>
        <text x={px} y={py} fill={stroke} fontSize={fs}
              fontFamily='"Segoe UI", sans-serif'
              fontWeight={selected ? 700 : 500}
              pointerEvents="none"
              style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.5)", strokeWidth: 2, strokeLinejoin: "round" }}>
          {drawing.text}
        </text>
        {clickable && (
          <rect x={px - 2} y={py - h + fs * 0.2} width={w + 4} height={h}
                fill="transparent" pointerEvents="all"
                {...bodyHandlers}
                onPointerDown={(e) => onHandleDown("single", e)}
                style={{ cursor: selected ? "grab" : "pointer" }} />
        )}
        {selected && !isPreview && (
          <rect x={px - 3} y={py - h + fs * 0.2} width={w + 6} height={h}
                fill="none" stroke={stroke} strokeWidth={1} strokeDasharray="3 2"
                pointerEvents="none" />
        )}
      </g>
    );
  }

  return null;
}
