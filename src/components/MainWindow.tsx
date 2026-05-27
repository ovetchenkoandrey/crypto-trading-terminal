import { useEffect } from "react";
import { useStore } from "../lib/store";
import type { PanelKey } from "../lib/store";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { MarketWatch } from "./MarketWatch";
import { OrderBook } from "./OrderBook";
import { Navigator } from "./Navigator";
import { Terminal } from "./Terminal";
import { StatusBar } from "./StatusBar";
import { ChartMosaic } from "./ChartMosaic";
import { ws, init as initWs } from "../lib/bybitWs";
import { logInfo, logOk } from "../lib/eventBus";

const SHORTCUTS: Record<string, PanelKey> = {
  m: "marketWatch",
  d: "orderBook",
  n: "navigator",
  t: "terminal",
};

export function MainWindow() {
  const theme       = useStore((s) => s.theme);
  const panels      = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const setTheme    = useStore((s) => s.setTheme);
  const activeSymbol = useStore((s) => s.activeSymbol);
  const watchlist    = useStore((s) => s.watchlist);

  // Theme attribute on body
  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  // Init WS once
  useEffect(() => {
    logInfo("app", "starting Trading App v0.2.0");
    initWs();
    // Subscribe tickers for the whole watchlist (so Market Watch is alive)
    ws.subscribeMany(watchlist.map((s) => `tickers.${s}`));
    logOk("app", `watching ${watchlist.length} symbols`);
    return () => { ws.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe orderbook for active symbol; resubscribe on change
  useEffect(() => {
    const topic = `orderbook.50.${activeSymbol}`;
    ws.subscribe(topic);
    useStore.getState().setOrderbook(null);
    return () => { ws.unsubscribe(topic); };
  }, [activeSymbol]);

  // Keyboard shortcuts (Ctrl+M/D/N/T for panels, Ctrl+J for theme)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        setTheme(useStore.getState().theme === "dark" ? "light" : "dark");
        return;
      }
      const panel = SHORTCUTS[key];
      if (!panel) return;
      e.preventDefault();
      togglePanel(panel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, setTheme]);

  return (
    <div className="app">
      <MenuBar />
      <Toolbar />

      <div className="body">
        {panels.marketWatch && (
          <div className="col-left">
            <MarketWatch />
          </div>
        )}

        <div className="col-center">
          <ChartMosaic />
        </div>

        {panels.orderBook && (
          <div className="col-dom">
            <OrderBook />
          </div>
        )}

        {panels.navigator && (
          <div className="col-right">
            <Navigator />
          </div>
        )}
      </div>

      {panels.terminal && <Terminal />}

      <StatusBar />
    </div>
  );
}
