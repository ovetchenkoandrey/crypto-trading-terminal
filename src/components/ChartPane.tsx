import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/types";
import type { ActiveIndicator } from "../lib/store";
import { getIndicatorDef } from "../lib/indicators/registry";

interface ChartPaneProps {
  data: Candle[];
  symbol?: string;
  timeframe?: string;
  indicators?: ActiveIndicator[];
  onAddIndicator?: (kind: string) => void;
  onRemoveIndicator?: (id: string) => void;
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
  // chart the series belong to (main or pane chart)
  isPaneChart: boolean;
}

export function ChartPane({ data, symbol, timeframe, indicators = [], onAddIndicator, onRemoveIndicator }: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const paneChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastLenRef = useRef<number>(0);
  const indSeriesRef = useRef<IndSeriesSet[]>([]);
  const [ohlc, setOhlc] = useState<OhlcDisplay | null>(null);

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
        vertLine: { color: fgDim, labelBackgroundColor: bgPanel },
        horzLine: { color: fgDim, labelBackgroundColor: bgPanel },
      },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: green,
      downColor: red,
      borderUpColor: green,
      borderDownColor: red,
      wickUpColor: green,
      wickDownColor: red,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      color: fgDim,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

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
        vertLine: { color: fgDim, labelBackgroundColor: bgPanel },
        horzLine: { color: fgDim, labelBackgroundColor: bgPanel },
      },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false, visible: true },
    });

    paneChartRef.current = paneChart;

    // Sync time scale with main chart
    const mainChart = chartRef.current;
    if (mainChart) {
      mainChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (range && paneChartRef.current) {
          paneChartRef.current.timeScale().setVisibleRange(range);
        }
      });
      paneChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (range && chartRef.current) {
          chartRef.current.timeScale().setVisibleRange(range);
        }
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
    const toCandle = (c: Candle) => ({
      time: c.time as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    });
    const toVol = (c: Candle) => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: (c.close >= c.open ? greenColor : redColor) + "99",
    });

    const prevLen = lastLenRef.current;
    const lenJump = data.length > prevLen + 1 || data.length < prevLen || prevLen === 0;

    if (lenJump) {
      candleSeries.setData(data.map(toCandle));
      volumeSeries.setData(data.map(toVol));
      chart.timeScale().fitContent();
    } else {
      candleSeries.update(toCandle(last));
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
        }
      } else {
        // Create new series
        const lineSeries: ISeriesApi<"Line">[] = output.lines.map((line) => {
          const s = targetChart.addSeries(LineSeries, {
            color: line.color,
            lineWidth: 1,
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

        indSeriesRef.current.push({ id: ind.id, lines: lineSeries, histogram: histSeries, isPaneChart });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators, data]);

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
        ref={containerRef}
        className="chart-host-inner"
        style={{ flex: hasPaneIndicators ? "1 1 65%" : "1 1 100%", minHeight: 0, display: isEmpty ? "none" : "block" }}
      />
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
      {!isEmpty && indicators.length > 0 && onRemoveIndicator && (
        <div style={{
          position: "absolute", top: 30, left: 8, zIndex: 10,
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          {indicators.map((ind) => {
            const def = getIndicatorDef(ind.kind);
            return (
              <div key={ind.id} style={{
                display: "flex", alignItems: "center", gap: 4,
                background: "rgba(13,17,23,0.75)", borderRadius: 3,
                padding: "1px 5px", fontSize: 10,
              }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: ind.color || def?.defaultColor || "#888", flexShrink: 0, display: "inline-block" }} />
                <span style={{ color: "var(--fg-dim)" }}>{def?.name ?? ind.kind}</span>
                <button
                  style={{ background: "transparent", border: 0, color: "var(--fg-mute)", cursor: "pointer", fontSize: 10, padding: "0 1px", lineHeight: 1 }}
                  onClick={() => onRemoveIndicator(ind.id)}
                  title="Удалить"
                >×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
