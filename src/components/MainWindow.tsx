import { useEffect, useState } from "react";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { MarketWatch } from "./MarketWatch";
import { OrderBook } from "./OrderBook";
import { Navigator } from "./Navigator";
import { Terminal } from "./Terminal";
import { StatusBar } from "./StatusBar";
import { ChartMosaic } from "./ChartMosaic";
import { fetchKlines } from "../lib/bybit";
import type { Candle, Interval } from "../lib/types";

export type PanelKey = "marketWatch" | "orderBook" | "navigator" | "terminal";
export type PanelsState = Record<PanelKey, boolean>;
export type LayoutKey = "1" | "2" | "4";

const SHORTCUTS: Record<string, PanelKey> = {
  m: "marketWatch",
  d: "orderBook",
  n: "navigator",
  t: "terminal",
};

export function MainWindow() {
  const [panels, setPanels] = useState<PanelsState>({
    marketWatch: true,
    orderBook: true,
    navigator: true,
    terminal: true,
  });
  const [layout, setLayout] = useState<LayoutKey>("1");
  const [symbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<string>("15");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const togglePanel = (k: PanelKey) =>
    setPanels((p) => ({ ...p, [k]: !p[k] }));

  // Keyboard shortcuts (Ctrl+M / Ctrl+D / Ctrl+N / Ctrl+T)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = SHORTCUTS[e.key.toLowerCase()];
      if (!key) return;
      e.preventDefault();
      togglePanel(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fetch klines whenever symbol or timeframe changes
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const t0 = performance.now();
    fetchKlines(symbol, timeframe as Interval, 200)
      .then((data) => {
        if (cancelled) return;
        setCandles(data);
        setConnected(true);
        setLatencyMs(Math.round(performance.now() - t0));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setConnected(false);
      });
    return () => { cancelled = true; };
  }, [symbol, timeframe]);

  const lastPrice = candles.length > 0 ? candles[candles.length - 1].close : undefined;

  const tfLabel = (() => {
    const map: Record<string, string> = {
      "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
      "60": "1h", "120": "2h", "240": "4h", "360": "6h", "720": "12h",
      "D": "1D", "W": "1W", "M": "1M",
    };
    return map[timeframe] ?? timeframe;
  })();

  return (
    <div className="app">
      <MenuBar />
      <Toolbar
        panels={panels}
        togglePanel={togglePanel}
        timeframe={timeframe}
        setTimeframe={setTimeframe}
        layout={layout}
        setLayout={setLayout}
      />

      <div className="body">
        {panels.marketWatch && (
          <div className="col-left">
            <MarketWatch activeSymbol={symbol} />
          </div>
        )}

        <div className="col-center">
          {error ? (
            <div style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              flexDirection: "column", gap: 12, padding: 24, color: "var(--red)",
            }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Ошибка подключения к Bybit</div>
              <div style={{ fontSize: 12, fontFamily: "monospace", color: "var(--fg-dim)", textAlign: "center", maxWidth: 600 }}>
                {error}
              </div>
            </div>
          ) : (
            <ChartMosaic
              layout={layout}
              candles={candles}
              primarySymbol={symbol}
              primaryTimeframe={tfLabel}
            />
          )}
        </div>

        {panels.orderBook && (
          <div className="col-dom">
            <OrderBook symbol={symbol} lastPrice={lastPrice} />
          </div>
        )}

        {panels.navigator && (
          <div className="col-right">
            <Navigator />
          </div>
        )}
      </div>

      {panels.terminal && <Terminal />}

      <StatusBar
        connected={connected}
        latencyMs={latencyMs}
        candleCount={candles.length}
      />
    </div>
  );
}
