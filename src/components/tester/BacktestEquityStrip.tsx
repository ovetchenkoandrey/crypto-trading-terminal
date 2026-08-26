// Equity curve under the price chart, locked to the same time axis.
//
// Two series on one pane: the equity line, and the depth of the drawdown from
// the running peak as a histogram pinned to the bottom. A drawdown drawn as a
// separate shape rather than as "the gap under the line" is the difference
// between noticing a 12% hole and squinting at a slope.

import { useEffect, useRef } from "react";
import {
  createChart, LineSeries, HistogramSeries, CrosshairMode,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import type { EquitySample } from "../../lib/execution/backtest/stats";
import { fmtUsdt } from "../../lib/format";

interface Props {
  /** Price chart to mirror the visible range with. */
  priceChart: IChartApi | null;
  priceSeries: ISeriesApi<"Candlestick" | "Line" | "Area"> | null;
  equity: readonly EquitySample[];
  initialBalance: number;
  /** Crosshair time coming from the price chart, UTC seconds. */
  hoverTimeSec: number | null;
  onHoverTime: (sec: number | null) => void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function BacktestEquityStrip({
  priceChart, priceSeries, equity, initialBalance, hoverTimeSec, onHoverTime,
}: Props) {
  const hostRef  = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef  = useRef<ISeriesApi<"Line"> | null>(null);
  const ddRef    = useRef<ISeriesApi<"Histogram"> | null>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      autoSize: false,
      layout: {
        background: { color: "transparent" },
        textColor: cssVar("--fg-dim") || "#8b93a7",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: cssVar("--border-soft") || "#22262f" },
        horzLines: { color: cssVar("--border-soft") || "#22262f" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: cssVar("--border") || "#2a2f3a" },
      timeScale: { borderColor: cssVar("--border") || "#2a2f3a", timeVisible: true, secondsVisible: false },
      // The strip is a slave of the price chart. Two-way range mirroring between
      // two lightweight-charts instances ping-pongs — each setVisibleRange fires
      // the other's range-change callback on a later tick, past any re-entry
      // guard — so the strip does not drive, it only follows.
      handleScale:  false,
      handleScroll: false,
    });

    const line = chart.addSeries(LineSeries, {
      color: cssVar("--accent") || "#f0b90b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const dd = chart.addSeries(HistogramSeries, {
      priceScaleId: "dd",
      color: "rgba(220,60,60,0.45)",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("dd").applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

    chartRef.current = chart;
    lineRef.current  = line;
    ddRef.current    = dd;

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) chart.applyOptions({ width: r.width, height: r.height });
    });
    ro.observe(el);

    chart.subscribeCrosshairMove((param) => {
      const t = param.time ? Number(param.time) : null;
      onHoverTime(t);
      const node = readoutRef.current;
      if (!node) return;
      const v = param.seriesData?.get(line) as { value?: number } | undefined;
      node.textContent = v?.value !== undefined ? `${fmtUsdt(v.value)} USDT` : "";
    });

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      lineRef.current = null;
      ddRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data
  useEffect(() => {
    const line = lineRef.current;
    const dd   = ddRef.current;
    if (!line || !dd) return;
    let peak = initialBalance;
    const linePts: { time: UTCTimestamp; value: number }[] = [];
    const ddPts:   { time: UTCTimestamp; value: number }[] = [];
    let lastTime = 0;
    for (const e of equity) {
      // Duplicate stamps would be rejected by the series; the equity sampler can
      // emit two rows for one bar when a bar closes more than one position.
      if (e.time <= lastTime) continue;
      lastTime = e.time;
      if (e.equity > peak) peak = e.equity;
      linePts.push({ time: e.time as UTCTimestamp, value: e.equity });
      ddPts.push({ time: e.time as UTCTimestamp, value: Math.max(0, peak - e.equity) });
    }
    line.setData(linePts);
    dd.setData(ddPts);
  }, [equity, initialBalance]);

  // One-way time-scale mirroring: price chart → strip.
  useEffect(() => {
    const eq = chartRef.current;
    if (!eq || !priceChart) return;
    const eqTs = eq.timeScale();
    const prTs = priceChart.timeScale();

    const mirror = () => {
      const r = prTs.getVisibleLogicalRange();
      if (!r) return;
      const cur = eqTs.getVisibleLogicalRange();
      // Skip no-op writes: they are what turns a mirror into a feedback loop.
      if (cur && Math.abs(cur.from - r.from) < 0.01 && Math.abs(cur.to - r.to) < 0.01) return;
      try { eqTs.setVisibleLogicalRange(r); } catch { /* series not ready */ }
    };

    prTs.subscribeVisibleLogicalRangeChange(mirror);
    mirror();
    const id = window.setTimeout(mirror, 60);
    return () => {
      window.clearTimeout(id);
      try { prTs.unsubscribeVisibleLogicalRangeChange(mirror); } catch { /* gone */ }
    };
  }, [priceChart, equity]);

  // Crosshair coming the other way: price chart → equity strip.
  useEffect(() => {
    const eq = chartRef.current;
    const line = lineRef.current;
    if (!eq || !line) return;
    if (hoverTimeSec === null) {
      eq.clearCrosshairPosition();
      return;
    }
    const sample = equity.find((e) => e.time >= hoverTimeSec);
    if (!sample) return;
    try { eq.setCrosshairPosition(sample.equity, sample.time as UTCTimestamp, line); }
    catch { /* out of range */ }
  }, [hoverTimeSec, equity]);

  void priceSeries;

  const final = equity.length ? equity[equity.length - 1].equity : initialBalance;
  const up = final >= initialBalance;

  return (
    <div className="bt-equity-strip" data-testid="bt-equity-strip">
      <div className="bt-equity-head">
        <span className="lbl">Эквити</span>
        <span className={up ? "pnl-pos" : "pnl-neg"}>{fmtUsdt(final)} USDT</span>
        <span className="dim">просадка от пика — красным снизу</span>
        <span className="readout" ref={readoutRef} />
      </div>
      <div className="bt-equity-canvas" ref={hostRef} />
    </div>
  );
}
