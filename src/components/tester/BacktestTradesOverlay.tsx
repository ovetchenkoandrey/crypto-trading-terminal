// Trades layer drawn over the backtest chart.
//
// One trade is three things: an entry triangle, an exit triangle and — the
// element that actually answers "why does this strategy work" — a segment
// between them, coloured by result. Everything is SVG in chart space, so it
// survives pan and zoom without the chart knowing about it.

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { TradeView, UnfilledOrderView } from "./model";

interface Props {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick" | "Line" | "Area">;
  trades: readonly TradeView[];
  unfilled: readonly UnfilledOrderView[];
  selectedId: string | null;
  showSegments: boolean;
  showMarkers: boolean;
  showRejected: boolean;
  onSelect: (id: string) => void;
}

/** Above this many trades in view the layer thins out — see pickVisible. */
const DRAW_BUDGET = 450;

const WIN  = "#3cc85a";
const LOSS = "#dc3c3c";
const BUY  = "#3cc85a";
const SELL = "#dc3c3c";

interface Placed {
  t: TradeView;
  x1: number; y1: number;
  x2: number; y2: number;
}

export function BacktestTradesOverlay({
  chart, series, trades, unfilled, selectedId,
  showSegments, showMarkers, showRejected, onSelect,
}: Props) {
  const [tick, force] = useReducer((x: number) => x + 1, 0);
  const hostRef = useRef<HTMLDivElement>(null);

  // Repaint on every pan / zoom / resize — the same contract SvgDrawingOverlay
  // uses. Cheap: we only recompute pixel coordinates for what is on screen.
  useEffect(() => {
    const ts = chart.timeScale();
    const onRange = () => force();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(() => force());
    if (hostRef.current) ro.observe(hostRef.current);
    force();
    return () => {
      try { ts.unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* chart gone */ }
      ro.disconnect();
    };
  }, [chart]);

  // Trades that overlap the visible time window, thinned to the draw budget.
  // The selected trade is never thinned away: clicking a row must always land
  // on something visible.
  const visible = useMemo(() => {
    const range = chart.timeScale().getVisibleRange();
    const from = range ? Number(range.from) : -Infinity;
    const to   = range ? Number(range.to)   : Infinity;
    const inView = trades.filter((t) => t.exitBarTime >= from && t.entryBarTime <= to);
    if (inView.length <= DRAW_BUDGET) return inView;
    const stride = Math.ceil(inView.length / DRAW_BUDGET);
    const thinned = inView.filter((_, i) => i % stride === 0);
    const sel = inView.find((t) => t.id === selectedId);
    if (sel && !thinned.some((t) => t.id === sel.id)) thinned.push(sel);
    return thinned;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, trades, selectedId, tick]);

  const placed: Placed[] = [];
  for (const t of visible) {
    const x1 = chart.timeScale().timeToCoordinate(t.entryBarTime as never);
    const x2 = chart.timeScale().timeToCoordinate(t.exitBarTime as never);
    const y1 = series.priceToCoordinate(t.entryPrice);
    const y2 = series.priceToCoordinate(t.exitPrice);
    if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
    placed.push({ t, x1: x1 as number, y1: y1 as number, x2: x2 as number, y2: y2 as number });
  }

  const rejects = showRejected
    ? unfilled.map((o) => {
        const x = chart.timeScale().timeToCoordinate(o.barTime as never);
        const y = series.priceToCoordinate(o.price);
        return x === null || y === null ? null : { o, x: x as number, y: y as number };
      }).filter((v): v is { o: UnfilledOrderView; x: number; y: number } => v !== null)
    : [];

  const thinned = visible.length < trades.length;

  return (
    <div ref={hostRef} className="bt-trades-overlay">
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {showRejected && rejects.map(({ o, x, y }) => (
          <g key={"r-" + o.id} opacity={0.55}>
            <line x1={x - 5} y1={y} x2={x + 5} y2={y}
                  stroke={o.side === "buy" ? BUY : SELL} strokeWidth={1} strokeDasharray="2 2" />
            <circle cx={x} cy={y} r={1.7} fill={o.side === "buy" ? BUY : SELL} />
          </g>
        ))}

        {placed.map(({ t, x1, y1, x2, y2 }) => {
          const win = t.pnl >= 0;
          const color = win ? WIN : LOSS;
          const selected = t.id === selectedId;
          return (
            <g key={t.id} className="bt-trade" onClick={() => onSelect(t.id)} style={{ pointerEvents: "auto", cursor: "pointer" }}>
              <title>
                {`#${t.index} ${t.side.toUpperCase()} ${t.qty}\n${t.entryPrice} → ${t.exitPrice}\nP/L ${t.pnl.toFixed(2)}`}
              </title>
              {/* fat invisible hit area so a 1px segment is still clickable */}
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={9} />
              {showSegments && (
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={color}
                  strokeWidth={selected ? 2.5 : 1.2}
                  strokeOpacity={selected ? 1 : 0.8}
                  strokeDasharray={win ? undefined : "4 2"}
                />
              )}
              {showMarkers && (
                <>
                  <Triangle x={x1} y={y1} up={t.side === "buy"} color={t.side === "buy" ? BUY : SELL} selected={selected} />
                  <Triangle x={x2} y={y2} up={t.side !== "buy"} color={color} selected={selected} hollow />
                </>
              )}
              {selected && (
                <>
                  <circle cx={x1} cy={y1} r={6} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
                  <circle cx={x2} cy={y2} r={6} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
                </>
              )}
            </g>
          );
        })}
      </svg>
      {thinned && (
        <div className="bt-thin-note">
          показано {visible.length} из {trades.length} — приблизь, чтобы увидеть все
        </div>
      )}
    </div>
  );
}

function Triangle({ x, y, up, color, selected, hollow }: {
  x: number; y: number; up: boolean; color: string; selected?: boolean; hollow?: boolean;
}) {
  const s = selected ? 6 : 4.5;
  const dir = up ? 1 : -1;
  // Sits just off the price so the segment endpoint stays readable.
  const cy = y + dir * (s + 2);
  const pts = `${x},${cy - dir * s} ${x - s},${cy + dir * s * 0.7} ${x + s},${cy + dir * s * 0.7}`;
  return (
    <polygon
      points={pts}
      fill={hollow ? "none" : color}
      stroke={color}
      strokeWidth={hollow ? 1.4 : 0.5}
    />
  );
}
