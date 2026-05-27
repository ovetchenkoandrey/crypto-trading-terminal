import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/types";

interface ChartPaneProps {
  data: Candle[];
  symbol?: string;
  timeframe?: string;
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

export function ChartPane({ data, symbol, timeframe }: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastLenRef = useRef<number>(0);
  const [ohlc, setOhlc] = useState<OhlcDisplay | null>(null);

  // Mount: create chart once. Cleanup on unmount.
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
      if (!param.time || !series) {
        // crosshair off-chart — show latest candle ohlc (set elsewhere)
        return;
      }
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
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      lastTimeRef.current = 0;
      lastLenRef.current = 0;
    };
  }, []);

  // Data: setData on first load / length jump, otherwise series.update on last candle.
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

  const isEmpty = data.length === 0;

  const closeColor = ohlc
    ? ohlc.close >= ohlc.open ? "var(--green)" : "var(--red)"
    : "var(--fg)";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", display: isEmpty ? "none" : "block" }}
      />
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
    </div>
  );
}
