import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
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

// Read a CSS variable value from :root
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function ChartPane({ data, symbol, timeframe }: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ohlc, setOhlc] = useState<OhlcDisplay | null>(null);

  const isEmpty = !data || data.length === 0;

  // Re-create chart whenever data changes (or on first mount)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (isEmpty) return;

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
      rightPriceScale: {
        borderColor: border,
        textColor: fgDim,
      },
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: green,
      downColor: red,
      borderUpColor: green,
      borderDownColor: red,
      wickUpColor: green,
      wickDownColor: red,
    });

    // Volume histogram — separate overlay price scale, occupies bottom ~20%
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      color: fgDim,
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // Set candle data
    const candleData = data.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    // Set volume data with per-bar color
    const volData = data.map((c) => ({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? green + "99" : red + "99",
    }));

    candleSeries.setData(candleData);
    volumeSeries.setData(volData);
    chart.timeScale().fitContent();

    // Show latest candle in overlay
    const last = data[data.length - 1];
    if (last) {
      setOhlc({ open: last.open, high: last.high, low: last.low, close: last.close });
    }

    // Update overlay on crosshair move
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        // crosshair left the chart — show last candle
        if (last) setOhlc({ open: last.open, high: last.high, low: last.low, close: last.close });
        return;
      }
      const bar = param.seriesData?.get(candleSeries);
      if (bar && "open" in bar) {
        setOhlc({ open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      }
    });

    // ResizeObserver
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      chart.applyOptions({ width, height });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [data, isEmpty]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeColor = ohlc
    ? ohlc.close >= ohlc.open
      ? "var(--green)"
      : "var(--red)"
    : "var(--fg)";

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Container is always in DOM so ref is always valid */}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: isEmpty ? "none" : "block",
        }}
      />

      {/* Loading placeholder */}
      {isEmpty && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-dim)",
            fontSize: 14,
          }}
        >
          Loading…
        </div>
      )}

      {/* Top-left overlay: symbol / timeframe / live OHLC */}
      {!isEmpty && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            pointerEvents: "none",
            display: "flex",
            gap: 10,
            alignItems: "baseline",
            fontFamily: '"Segoe UI", -apple-system, system-ui, sans-serif',
            fontSize: 11,
            lineHeight: 1.4,
            zIndex: 10,
          }}
        >
          {(symbol || timeframe) && (
            <span style={{ color: "var(--fg)", fontWeight: 600 }}>
              {symbol}{timeframe ? ` ${timeframe}` : ""}
            </span>
          )}
          {ohlc && (
            <>
              <span style={{ color: "var(--fg-dim)" }}>
                O <span style={{ color: "var(--fg)" }}>{ohlc.open.toFixed(2)}</span>
              </span>
              <span style={{ color: "var(--fg-dim)" }}>
                H <span style={{ color: "var(--fg)" }}>{ohlc.high.toFixed(2)}</span>
              </span>
              <span style={{ color: "var(--fg-dim)" }}>
                L <span style={{ color: "var(--fg)" }}>{ohlc.low.toFixed(2)}</span>
              </span>
              <span style={{ color: "var(--fg-dim)" }}>
                C <span style={{ color: closeColor }}>{ohlc.close.toFixed(2)}</span>
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
