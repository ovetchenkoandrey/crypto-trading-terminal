import { useEffect } from "react";
import { useStore } from "../lib/store";
import type { PanelKey } from "../lib/store";
import { MenuBar } from "./MenuBar";
import { Toolbar } from "./Toolbar";
import { OrderBook } from "./OrderBook";
import { Navigator } from "./Navigator";
import { Terminal } from "./Terminal";
import { StatusBar } from "./StatusBar";
import { ChartMosaic } from "./ChartMosaic";
import { ws, init as initWs } from "../lib/bybitWs";
import { loadInstruments } from "../lib/instruments";
import { logInfo } from "../lib/eventBus";
import { paperEngine } from "../lib/paper/engine";
import { botManager } from "../lib/bots/manager";

const SHORTCUTS: Record<string, PanelKey> = {
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
  const settings     = useStore((s) => s.settings);

  // Theme attribute on body
  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);

  // Apply user-customisable colors and font scale as CSS variables on <body>.
  // Inline body styles win over :root values from global.css.
  useEffect(() => {
    const s = settings.appearance;
    const FONT_SCALE = { sm: 0.9, md: 1, lg: 1.15 } as const;
    document.body.style.setProperty("--accent", s.accentColor);
    document.body.style.setProperty("--green",  s.candleUpColor);
    document.body.style.setProperty("--red",    s.candleDownColor);
    document.body.style.setProperty("--font-scale", String(FONT_SCALE[s.fontScale]));
  }, [settings.appearance]);

  // Init WS + paper engine + bot manager once + load full symbol list
  useEffect(() => {
    logInfo("app", "starting Trading App v0.2.0");
    initWs();
    paperEngine.init();
    botManager.init();
    loadInstruments();   // populates store.allSymbols (spot + linear)
    return () => {
      ws.disconnect();
      paperEngine.shutdown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe orderbook for active symbol; resubscribe on change
  useEffect(() => {
    const topic = `orderbook.50.${activeSymbol}`;
    ws.subscribe(topic, activeSymbol);
    useStore.getState().setOrderbook(null);
    return () => { ws.unsubscribe(topic, activeSymbol); };
  }, [activeSymbol]);

  // Keyboard shortcuts (Ctrl+D/N/T for panels, Ctrl+J for theme)
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
