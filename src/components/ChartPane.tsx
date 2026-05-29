import { useEffect, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/types";
import type { ActiveIndicator, Drawing } from "../lib/store";
import type { ChartType } from "../lib/settings";
import type { DrawingTool } from "../lib/drawings/types";
import { getIndicatorDef } from "../lib/indicators/registry";
import { IndicatorParamsDialog } from "./IndicatorParamsDialog";
import { SvgDrawingOverlay } from "./SvgDrawingOverlay";
import { DrawingParamsDialog } from "./DrawingParamsDialog";
import { useStore } from "../lib/store";

interface ChartPaneProps {
  data: Candle[];
  symbol?: string;
  timeframe?: string;
  chartType?: ChartType;
  indicators?: ActiveIndicator[];
  onAddIndicator?: (kind: string) => void;
  onRemoveIndicator?: (id: string) => void;
  onUpdateIndicator?: (id: string, partial: Partial<ActiveIndicator>) => void;

  drawings?: Drawing[];
  activeTool?: DrawingTool;
  onAddDrawing?: (d: Drawing) => void;
  onRemoveDrawing?: (id: string) => void;
  onUpdateDrawing?: (id: string, partial: Partial<Drawing>) => void;
  onToolDone?: () => void;
}

function indicatorLabel(ind: ActiveIndicator): string {
  const def = getIndicatorDef(ind.kind);
  const baseName = def?.name ?? ind.kind;
  const p = ind.params;
  switch (ind.kind) {
    case "sma":
    case "ema":
    case "rsi":
    case "bollinger":
      return `${baseName} (${p.period})`;
    case "macd":
      return `${baseName} (${p.fast}/${p.slow}/${p.signal})`;
    default:
      return baseName;
  }
}

interface OhlcDisplay {
  open: number;
  high: number;
  low: number;
  close: number;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Tracks series created for one indicator instance
interface IndSeriesSet {
  id: string;
  lines: ISeriesApi<"Line">[];
  histogram: ISeriesApi<"Histogram"> | null;
  // markers plugin attached to the main candle series (used by fractals etc.)
  markers: ISeriesMarkersPluginApi<Time> | null;
  // chart the series belong to (main or pane chart)
  isPaneChart: boolean;
}

export function ChartPane({
  data, symbol, timeframe, chartType = "candle",
  indicators = [], onAddIndicator, onRemoveIndicator, onUpdateIndicator,
  drawings = [], activeTool = "cursor", onAddDrawing, onRemoveDrawing, onUpdateDrawing, onToolDone,
}: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const paneChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick" | "Line" | "Area"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastLenRef = useRef<number>(0);
  const indSeriesRef = useRef<IndSeriesSet[]>([]);
  // Live price lines on the chart for open positions and pending orders.
  // Recreated wholesale on every state change — N is small (<100) so this is cheap.
  const tradingLinesRef = useRef<import("lightweight-charts").IPriceLine[]>([]);
  // Marker plugin for fill triangles (▲ buy, ▼ sell) on candles. Separate from
  // the indicator markers plugin so we can refresh it independently.
  const fillMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [ohlc, setOhlc] = useState<OhlcDisplay | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [editingDrawing, setEditingDrawing] = useState<string | null>(null);
  const [chartReady, setChartReady] = useState(0);   // bumped after series exist to mount overlay
  const disableMagnetOnSelection = useStore((s) => s.settings.drawings.disableMagnetOnSelection);
  const openOrderPopup = useStore((s) => s.openOrderPopup);
  const lastUsedQty    = useStore((s) => s.lastUsedQty);

  // Toggle crosshair magnet based on whether a drawing is selected — keeps the
  // crosshair out of the way while you're editing handles.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const mode = (selectedDrawing && disableMagnetOnSelection) ? CrosshairMode.Normal : CrosshairMode.MagnetOHLC;
    chart.applyOptions({ crosshair: { mode } });
  }, [selectedDrawing, disableMagnetOnSelection]);

  // Click on empty chart area while in cursor mode → open Order popup.
  // We use chart.subscribeClick (lightweight-charts native) because the SVG
  // overlay has pointer-events: none in cursor mode (to let pan/zoom through),
  // so a React-level click handler never fires there.
  useEffect(() => {
    if (chartReady <= 0) return;
    const chart    = chartRef.current;
    const series   = candleSeriesRef.current;
    const container = containerRef.current;
    if (!chart || !series || !container || !symbol) return;

    const handler = (param: import("lightweight-charts").MouseEventParams) => {
      // Only act in cursor mode; drawing tools handle their own clicks.
      if (activeTool !== "cursor") return;
      // If a drawing is selected, this click was used for deselection — don't open popup.
      if (selectedDrawing) return;
      if (!param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null || price === undefined || price <= 0) return;
      const last = useStore.getState().tickers[symbol]?.lastPrice;
      if (!last) return;
      const side: "buy" | "sell" = price > last ? "sell" : "buy";
      // Convert canvas-space click point to viewport coordinates for popup anchor.
      const rect = container.getBoundingClientRect();
      const anchor = { x: rect.left + param.point.x, y: rect.top + param.point.y };
      openOrderPopup({
        symbol,
        side,
        type: "limit",
        price: +price,
        qty: lastUsedQty > 0 ? lastUsedQty : undefined,
      }, anchor);
    };

    chart.subscribeClick(handler);
    return () => { chart.unsubscribeClick(handler); };
  }, [chartReady, activeTool, selectedDrawing, symbol, openOrderPopup, lastUsedQty]);

  // Track whether we need the pane chart
  const hasPaneIndicators = indicators.some((ind) => {
    const def = getIndicatorDef(ind.kind);
    return def?.region === "pane";
  });

  // Mount: create main chart
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const bg      = cssVar("--bg");
    const bgPanel = cssVar("--bg-panel");
    const fg      = cssVar("--fg");
    const fgDim   = cssVar("--fg-dim");
    const green   = cssVar("--green");
    const red     = cssVar("--red");
    const grid    = cssVar("--grid");
    const border  = cssVar("--border");

    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: bg },
        textColor: fg,
        fontFamily: '"Segoe UI", -apple-system, system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: grid },
        horzLines: { color: grid },
      },
      crosshair: {
        // Magnet to nearest of O/H/L/C of the hovered candle when cursor is close.
        // Falls back to Magnet (close) when far — that's MagnetOHLC's built-in behavior.
        mode: CrosshairMode.MagnetOHLC,
        vertLine: { color: fgDim, labelBackgroundColor: bgPanel },
        horzLine: { color: fgDim, labelBackgroundColor: bgPanel },
      },
      rightPriceScale: { borderColor: border },
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: false,
        // Small buffer on the right so the latest candle isn't glued to the price axis
        rightOffset: 6,
        lockVisibleTimeRangeOnResize: true,
        minBarSpacing: 2,
      },
      // Wheel = zoom (in/out). Mouse drag = horizontal scroll. Axis-drag does nothing.
      handleScale: {
        axisPressedMouseMove: { time: false, price: false }, // OFF — was stretching bars
        axisDoubleClickReset: false,
        mouseWheel: true,           // wheel = zoom
        pinch: true,
      },
      handleScroll: {
        mouseWheel: false,          // wheel reserved for zoom (above)
        pressedMouseMove: true,     // drag = horizontal scroll
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      kineticScroll: { mouse: false, touch: true },
    });

    // Main price series — picks the lightweight-charts series type by chartType prop.
    let candleSeries: ISeriesApi<"Candlestick" | "Line" | "Area">;
    if (chartType === "line") {
      candleSeries = chart.addSeries(LineSeries, {
        color: green,
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
      }) as unknown as ISeriesApi<"Candlestick" | "Line" | "Area">;
    } else if (chartType === "area") {
      candleSeries = chart.addSeries(AreaSeries, {
        lineColor: green,
        topColor: green + "55",      // ~33% alpha at top
        bottomColor: green + "08",   // fade to almost transparent
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
      }) as unknown as ISeriesApi<"Candlestick" | "Line" | "Area">;
    } else {
      candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: green,
        downColor: red,
        borderUpColor: green,
        borderDownColor: red,
        wickUpColor: green,
        wickDownColor: red,
      }) as unknown as ISeriesApi<"Candlestick" | "Line" | "Area">;
    }

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      color: fgDim,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    setChartReady((n) => n + 1);   // overlay can mount now that chart+series exist

    // Toolbar's ⏵ button asks every chart to scroll to the latest bar
    const onScrollToRealtime = () => chartRef.current?.timeScale().scrollToRealTime();
    window.addEventListener("trading-app:scroll-to-realtime", onScrollToRealtime);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width, height });
    });
    ro.observe(el);

    chart.subscribeCrosshairMove((param) => {
      const series = candleSeriesRef.current;
      if (!param.time || !series) return;
      const bar = param.seriesData?.get(series);
      if (bar && "open" in bar) {
        setOhlc({
          open: bar.open as number,
          high: bar.high as number,
          low: bar.low as number,
          close: bar.close as number,
        });
      }
    });

    return () => {
      window.removeEventListener("trading-app:scroll-to-realtime", onScrollToRealtime);
      ro.disconnect();
      // cleanup all indicator series before removing chart
      indSeriesRef.current = [];
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      lastTimeRef.current = 0;
      lastLenRef.current = 0;
    };
  }, []);

  // Pane chart: create/destroy based on hasPaneIndicators
  useEffect(() => {
    const el = paneContainerRef.current;
    if (!el) return;

    if (!hasPaneIndicators) {
      if (paneChartRef.current) {
        paneChartRef.current.remove();
        paneChartRef.current = null;
      }
      return;
    }

    if (paneChartRef.current) return; // already exists

    const bg     = cssVar("--bg");
    const bgPanel = cssVar("--bg-panel");
    const fg     = cssVar("--fg");
    const fgDim  = cssVar("--fg-dim");
    const grid   = cssVar("--grid");
    const border = cssVar("--border");

    const paneChart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: bg },
        textColor: fg,
        fontFamily: '"Segoe UI", -apple-system, system-ui, sans-serif',
        fontSize: 10,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: {
        // Magnet to nearest of O/H/L/C of the hovered candle when cursor is close.
        // Falls back to Magnet (close) when far — that's MagnetOHLC's built-in behavior.
        mode: CrosshairMode.MagnetOHLC,
        vertLine: { color: fgDim, labelBackgroundColor: bgPanel },
        horzLine: { color: fgDim, labelBackgroundColor: bgPanel },
      },
      rightPriceScale: { borderColor: border },
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: false,
        visible: true,
        rightOffset: 6,
        lockVisibleTimeRangeOnResize: true,
        minBarSpacing: 2,
      },
      handleScale: {
        axisPressedMouseMove: { time: false, price: false },
        axisDoubleClickReset: false,
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      kineticScroll: { mouse: false, touch: true },
    });

    paneChartRef.current = paneChart;

    // Sync time scale between main and pane (guarded against ping-pong)
    const mainChart = chartRef.current;
    if (mainChart) {
      let syncing = false;
      mainChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (syncing || !range || !paneChartRef.current) return;
        syncing = true;
        try { paneChartRef.current.timeScale().setVisibleRange(range); }
        finally { syncing = false; }
      });
      paneChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (syncing || !range || !chartRef.current) return;
        syncing = true;
        try { chartRef.current.timeScale().setVisibleRange(range); }
        finally { syncing = false; }
      });
    }

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      paneChart.applyOptions({ width, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      paneChart.remove();
      paneChartRef.current = null;
    };
  }, [hasPaneIndicators]);

  // Data update effect
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart || data.length === 0) return;

    const last = data[data.length - 1];
    const greenColor = cssVar("--green");
    const redColor = cssVar("--red");

    // Format depends on the series type: candlesticks use OHLC, line/area use {time, value}.
    const toMain = (c: Candle): { time: UTCTimestamp; value: number } | { time: UTCTimestamp; open: number; high: number; low: number; close: number } => {
      if (chartType === "line" || chartType === "area") {
        return { time: c.time as UTCTimestamp, value: c.close };
      }
      return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
    };
    const toVol = (c: Candle) => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: (c.close >= c.open ? greenColor : redColor) + "99",
    });

    const prevLen = lastLenRef.current;
    const isInitial = prevLen === 0;
    const bigJump = data.length > prevLen + 1 || data.length < prevLen;
    // Covers the case where WS ticks 1-2 candles in before REST arrives with the full set —
    // we still want to reset the view on that first big drop, not just on the very first paint.
    const firstFullLoad = bigJump && data.length > 50 && prevLen < 50;

    if (isInitial || bigJump) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleSeries.setData(data.map(toMain) as any);
      volumeSeries.setData(data.map(toVol));
      // Defer one frame so the chart definitely knows its post-layout size.
      if (isInitial || firstFullLoad) {
        // Show last 200 bars by default; older history is still in memory and reachable by scrolling left.
        const VISIBLE_BARS = 200;
        const total = data.length;
        requestAnimationFrame(() => {
          const ts = chartRef.current?.timeScale();
          if (!ts) return;
          if (total <= VISIBLE_BARS) {
            ts.fitContent();
          } else {
            // rightOffset=6 lives in chart options, include it on the right so the latest candle isn't glued to the price axis
            ts.setVisibleLogicalRange({ from: total - VISIBLE_BARS, to: total + 6 });
          }
        });
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candleSeries.update(toMain(last) as any);
      volumeSeries.update(toVol(last));
    }

    lastLenRef.current = data.length;
    lastTimeRef.current = last.time;
    setOhlc({ open: last.open, high: last.high, low: last.low, close: last.close });
  }, [data]);

  // Indicator sync effect
  useEffect(() => {
    const mainChart = chartRef.current;
    if (!mainChart || data.length === 0) return;

    const fgDim = cssVar("--fg-dim");
    const currentIds = new Set(indicators.map((ind) => ind.id));

    // Remove series for indicators that no longer exist
    indSeriesRef.current = indSeriesRef.current.filter((set) => {
      if (currentIds.has(set.id)) return true;
      const targetChart = set.isPaneChart ? paneChartRef.current : mainChart;
      if (targetChart) {
        set.lines.forEach((s) => { try { targetChart.removeSeries(s); } catch { /* already gone */ } });
        if (set.histogram) { try { targetChart.removeSeries(set.histogram); } catch { /* already gone */ } }
      }
      if (set.markers) { try { set.markers.detach(); } catch { /* already gone */ } }
      return false;
    });

    const existingIds = new Set(indSeriesRef.current.map((s) => s.id));

    // Add/update indicators
    for (const ind of indicators) {
      const def = getIndicatorDef(ind.kind);
      if (!def) continue;

      const isPaneChart = def.region === "pane";
      const targetChart = isPaneChart ? paneChartRef.current : mainChart;
      if (!targetChart) continue;

      const output = def.compute(data, { ...ind.params, ...(ind.color ? { color: ind.color } : {}) });

      if (existingIds.has(ind.id)) {
        // Update existing series data
        const set = indSeriesRef.current.find((s) => s.id === ind.id);
        if (set) {
          output.lines.forEach((line, i) => {
            const s = set.lines[i];
            if (s) s.setData(line.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
          });
          if (set.histogram && output.histogram) {
            set.histogram.setData(output.histogram.map((p) => ({
              time: p.time as UTCTimestamp,
              value: p.value,
              color: p.color,
            })));
          }
          if (set.markers) {
            const next: SeriesMarker<Time>[] = (output.markers ?? []).map((m) => ({
              time: m.time as UTCTimestamp,
              position: m.position,
              shape: m.shape,
              color: m.color,
              text: m.text,
              size: m.size,
            }));
            set.markers.setMarkers(next);
          }
        }
      } else {
        // Create new series
        const lw = (ind.lineWidth ?? 1) as 1 | 2 | 3 | 4;
        const lineSeries: ISeriesApi<"Line">[] = output.lines.map((line) => {
          const s = targetChart.addSeries(LineSeries, {
            color: line.color,
            lineWidth: lw,
            priceScaleId: isPaneChart ? "right" : "",
            lastValueVisible: true,
            priceLineVisible: false,
          });
          s.setData(line.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
          return s;
        });

        if (isPaneChart && output.lines[0]?.paneRelativeMin !== undefined) {
          targetChart.priceScale("right").applyOptions({
            autoScale: true,
          });
        }

        let histSeries: ISeriesApi<"Histogram"> | null = null;
        if (output.histogram && output.histogram.length > 0) {
          histSeries = targetChart.addSeries(HistogramSeries, {
            color: fgDim,
            priceScaleId: "right",
            lastValueVisible: false,
            priceLineVisible: false,
          });
          histSeries.setData(output.histogram.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.value,
            color: p.color,
          })));
        }

        // Marker indicators (e.g. fractals) attach the markers plugin to the main candle series.
        // We deliberately attach to the candle/line/area series even for pane indicators —
        // markers without a price coordinate don't make sense in a pane.
        let markersApi: ISeriesMarkersPluginApi<Time> | null = null;
        if (output.markers && output.markers.length > 0 && candleSeriesRef.current) {
          markersApi = createSeriesMarkers(candleSeriesRef.current, output.markers.map((m) => ({
            time: m.time as UTCTimestamp,
            position: m.position,
            shape: m.shape,
            color: m.color,
            text: m.text,
            size: m.size,
          })));
        }

        indSeriesRef.current.push({ id: ind.id, lines: lineSeries, histogram: histSeries, markers: markersApi, isPaneChart });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, data]);

  // ─── Trading overlay: position / order price lines + fill markers on candles ───
  // Subscribes to venue snapshots through paper* store slices (works for any venue
  // that writes to those — currently Paper). When backtest/demo/live venues land,
  // they'll write to the same slices through their adapters.
  const allPositions = useStore((s) => s.paperPositions);
  const allOrders    = useStore((s) => s.paperOrders);
  const allHistory   = useStore((s) => s.paperHistory);
  const showTradingOverlay = useStore((s) => s.settings.paperTrading.pnlMode); // dummy dep until a dedicated setting
  void showTradingOverlay;
  useEffect(() => {
    if (chartReady <= 0) return;
    const candle = candleSeriesRef.current;
    if (!candle || !symbol) return;

    // Always clear previous lines first — cheap, avoids drift on partial updates.
    tradingLinesRef.current.forEach((pl) => { try { candle.removePriceLine(pl); } catch { /* gone */ } });
    tradingLinesRef.current = [];

    // 1. Open positions for THIS symbol
    const positions = allPositions.filter((p) => p.symbol === symbol);
    for (const p of positions) {
      const isBuy = p.side === "buy";
      const pl = candle.createPriceLine({
        price: p.entryPrice,
        color: isBuy ? "#3cc85a" : "#dc3c3c",
        lineWidth: 2,
        lineStyle: 0,         // Solid
        axisLabelVisible: true,
        title: `${isBuy ? "LONG" : "SHORT"} ${p.qty}`,
      });
      tradingLinesRef.current.push(pl);
    }

    // 2. Pending limit / stop orders for THIS symbol
    const orders = allOrders.filter((o) => o.status === "pending" && o.symbol === symbol);
    for (const o of orders) {
      const isBuy = o.side === "buy";
      const pl = candle.createPriceLine({
        price: o.price,
        color: isBuy ? "rgba(60,200,90,0.75)" : "rgba(220,60,60,0.75)",
        lineWidth: 1,
        lineStyle: 2,         // Dashed
        axisLabelVisible: true,
        title: `${o.type === "stop" ? "STOP" : "LIMIT"} ${o.side.toUpperCase()} ${o.qty}`,
      });
      tradingLinesRef.current.push(pl);
    }

    // 3. Fill markers from trade history (entry+exit triangles). Keep just the last 100
    //    for the visible symbol — older fills clutter the chart.
    const fills = allHistory
      .filter((t) => t.symbol === symbol)
      .slice(-100)
      .map((t): SeriesMarker<Time> => ({
        time: Math.floor(t.ts / 1000) as UTCTimestamp,
        position: t.side === "buy" ? "belowBar" : "aboveBar",
        shape:    t.side === "buy" ? "arrowUp"  : "arrowDown",
        color:    t.pnl >= 0 ? "#3cc85a" : "#dc3c3c",
        size:     1,
      }));

    if (fillMarkersRef.current) {
      fillMarkersRef.current.setMarkers(fills);
    } else if (fills.length > 0) {
      fillMarkersRef.current = createSeriesMarkers(candle, fills);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartReady, symbol, allPositions, allOrders, allHistory]);

  const isEmpty = data.length === 0;

  const closeColor = ohlc
    ? ohlc.close >= ohlc.open ? "var(--green)" : "var(--red)"
    : "var(--fg)";

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const raw = e.dataTransfer.getData("application/x-indicator");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { kind: string };
      if (parsed.kind && onAddIndicator) onAddIndicator(parsed.kind);
    } catch { /* ignore malformed */ }
  };

  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column" }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className="chart-host-inner-wrap"
        style={{ position: "relative", flex: hasPaneIndicators ? "1 1 65%" : "1 1 100%", minHeight: 0, display: isEmpty ? "none" : "block" }}
      >
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {chartReady > 0 && chartRef.current && candleSeriesRef.current && (
          <SvgDrawingOverlay
            chart={chartRef.current}
            series={candleSeriesRef.current}
            candles={data}
            drawings={drawings}
            activeTool={activeTool}
            selectedId={selectedDrawing}
            defaultColor={cssVar("--accent") || "#f0b90b"}
            onCreate={(d) => onAddDrawing?.(d)}
            onSelect={(id) => setSelectedDrawing(id)}
            onUpdate={(id, partial) => onUpdateDrawing?.(id, partial)}
            onDelete={(id) => onRemoveDrawing?.(id)}
            onEdit={(id) => setEditingDrawing(id)}
            onToolDone={() => onToolDone?.()}
          />
        )}
      </div>
      {hasPaneIndicators && (
        <div
          ref={paneContainerRef}
          className="chart-pane-secondary"
          style={{ flex: "1 1 35%", minHeight: 0, borderTop: "1px solid var(--border-soft)" }}
        />
      )}
      {isEmpty && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)", fontSize: 14 }}>
          Loading…
        </div>
      )}
      {!isEmpty && (symbol || timeframe || ohlc) && (
        <div style={{
          position: "absolute", top: 8, left: 8, pointerEvents: "none",
          display: "flex", gap: 10, alignItems: "baseline",
          fontFamily: '"Segoe UI", sans-serif', fontSize: 11, lineHeight: 1.4, zIndex: 10,
        }}>
          {(symbol || timeframe) && (
            <span style={{ color: "var(--fg)", fontWeight: 600 }}>
              {symbol}{timeframe ? ` ${timeframe}` : ""}
            </span>
          )}
          {ohlc && (
            <>
              <span style={{ color: "var(--fg-dim)" }}>O <span style={{ color: "var(--fg)" }}>{ohlc.open.toFixed(2)}</span></span>
              <span style={{ color: "var(--fg-dim)" }}>H <span style={{ color: "var(--fg)" }}>{ohlc.high.toFixed(2)}</span></span>
              <span style={{ color: "var(--fg-dim)" }}>L <span style={{ color: "var(--fg)" }}>{ohlc.low.toFixed(2)}</span></span>
              <span style={{ color: "var(--fg-dim)" }}>C <span style={{ color: closeColor }}>{ohlc.close.toFixed(2)}</span></span>
            </>
          )}
        </div>
      )}
      {!isEmpty && indicators.length > 0 && (
        <div className="ind-badges">
          {indicators.map((ind) => {
            const def = getIndicatorDef(ind.kind);
            const dotColor = ind.color || def?.defaultColor || "#888";
            return (
              <div key={ind.id} className="ind-badge">
                <span className="ind-badge-dot" style={{ background: dotColor }} />
                <span className="ind-badge-label">{indicatorLabel(ind)}</span>
                {onUpdateIndicator && (
                  <button
                    className="ind-badge-btn"
                    onClick={() => setEditingId(ind.id)}
                    title="Параметры"
                  >⚙</button>
                )}
                {onRemoveIndicator && (
                  <button
                    className="ind-badge-btn"
                    onClick={() => onRemoveIndicator(ind.id)}
                    title="Удалить"
                  >×</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingId && onUpdateIndicator && (() => {
        const ind = indicators.find((i) => i.id === editingId);
        if (!ind) return null;
        return (
          <IndicatorParamsDialog
            indicator={ind}
            onSave={(partial) => onUpdateIndicator(ind.id, partial)}
            onClose={() => setEditingId(null)}
          />
        );
      })()}
      {editingDrawing && onUpdateDrawing && (() => {
        const d = drawings.find((x) => x.id === editingDrawing);
        if (!d) return null;
        return (
          <DrawingParamsDialog
            drawing={d}
            onSave={(partial) => onUpdateDrawing(d.id, partial)}
            onClose={() => setEditingDrawing(null)}
            onDelete={onRemoveDrawing ? () => onRemoveDrawing(d.id) : undefined}
          />
        );
      })()}
    </div>
  );
}
