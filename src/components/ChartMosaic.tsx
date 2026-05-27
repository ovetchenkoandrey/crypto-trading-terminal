import { useEffect } from "react";
import { useStore } from "../lib/store";
import { ChartPane } from "./ChartPane";
import { fetchKlines } from "../lib/bybit";
import { ws } from "../lib/bybitWs";
import { tfLabel } from "../lib/symbols";
import { fmtPrice, fmtPercent } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";
import { logError } from "../lib/eventBus";
import type { Interval } from "../lib/types";

export function ChartMosaic() {
  const layout = useStore((s) => s.layout);
  const cells = useStore((s) => s.mosaicCells);
  const candles = useStore((s) => s.candles);
  const tickers = useStore((s) => s.tickers);
  const setCandles = useStore((s) => s.setCandles);

  const count = layout === "1" ? 1 : layout === "2" ? 2 : 4;
  const visible = cells.slice(0, count);

  // For each visible cell, ensure we have klines loaded and WS subscribed
  useEffect(() => {
    const wantedTopics = new Set<string>();
    for (const c of visible) {
      const key = `${c.symbol}.${c.timeframe}`;
      wantedTopics.add(`kline.${c.timeframe}.${c.symbol}`);
      if (!candles[key] || candles[key].length === 0) {
        fetchKlines(c.symbol, c.timeframe as Interval, 200)
          .then((data) => setCandles(key, data))
          .catch((err: unknown) => logError("rest", `klines ${c.symbol}.${c.timeframe}: ${err instanceof Error ? err.message : String(err)}`));
      }
      ws.subscribe(`kline.${c.timeframe}.${c.symbol}`);
    }
    // Unsubscribe topics for cells not visible
    return () => {
      for (const c of visible) {
        const topic = `kline.${c.timeframe}.${c.symbol}`;
        if (!wantedTopics.has(topic)) ws.unsubscribe(topic);
      }
    };
  // We include candles only via its keyset to avoid loops; passing it directly would re-run on every tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((c) => `${c.symbol}.${c.timeframe}`).join("|")]);

  return (
    <div className={"chart-mosaic layout-" + layout}>
      {visible.map((cell, i) => {
        const key = `${cell.symbol}.${cell.timeframe}`;
        const data = candles[key] ?? [];
        const ticker = tickers[cell.symbol];
        const precision = getPricePrecision(cell.symbol, ticker?.lastPrice);
        const ch = ticker?.change24h ?? 0;
        const dir = ch >= 0 ? "up" : "dn";
        return (
          <div key={`${i}-${key}`} className={"chart-cell" + (i === 0 ? " active" : "")}>
            <div className="chart-cell-head">
              <span className="sym">{cell.symbol}</span>
              <span className="tf">{tfLabel(cell.timeframe)}</span>
              {ticker && (
                <>
                  <span className="price">{fmtPrice(ticker.lastPrice, precision)}</span>
                  <span className={"ch " + dir}>{fmtPercent(ch)}</span>
                </>
              )}
            </div>
            <div className="chart-host">
              <ChartPane data={data} symbol={cell.symbol} timeframe={tfLabel(cell.timeframe)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
