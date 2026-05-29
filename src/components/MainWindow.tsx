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
import { venue } from "../lib/execution/router";
import { botManager } from "../lib/bots/manager";
import { OrderPopup } from "./order/OrderPopup";

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
  const venueMode    = useStore((s) => s.venueMode);

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

  // Keep VenueRouter aligned with persisted venueMode (e.g. user picked a non-paper
  // venue, app restarts → switch to it).
  useEffect(() => {
    if (venue.mode !== venueMode) venue.switchMode(venueMode);
  }, [venueMode]);

  // Init WS + paper engine + bot manager once + load full symbol list
  useEffect(() => {
    logInfo("app", "starting Trading App v0.2.0");
    initWs();
    venue.init();           // starts the active execution venue (paper by default)
    botManager.init();
    loadInstruments();   // populates store.allSymbols (spot + linear)
    return () => {
      ws.disconnect();
      venue.shutdown();
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

  // F9 → open Order popup centred; B/S → open with Market + side + qty-focused
  // (only when the "quick keys" dangerous shortcut is enabled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing into inputs / textareas.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const st = useStore.getState();
      const sym  = st.activeSymbol;
      const qty  = st.lastUsedQty > 0 ? st.lastUsedQty : undefined;

      if (e.key === "F9") {
        e.preventDefault();
        st.openOrderPopup({ symbol: sym, type: "market", qty }, null);
        return;
      }
      if (st.settings.dangerous.quickBuySellKeys) {
        const k = e.key.toLowerCase();
        if (k === "b") {
          e.preventDefault();
          st.openOrderPopup({ symbol: sym, side: "buy",  type: "market", qty, focusQty: true }, null);
        } else if (k === "s") {
          e.preventDefault();
          st.openOrderPopup({ symbol: sym, side: "sell", type: "market", qty, focusQty: true }, null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      <OrderPopup />
    </div>
  );
}
