import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import type { VenueMode } from "../lib/store";
import { fmtPrice, fmtUsdt } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";

function venueLabel(mode: VenueMode): string {
  switch (mode) {
    case "paper":    return "🟢 PAPER";
    case "demo":     return "🟡 DEMO";
    case "live":     return "🔴 LIVE";
    case "backtest": return "🔵 BACKTEST";
  }
}

export function StatusBar() {
  const connection   = useStore((s) => s.connection);
  const activeSymbol = useStore((s) => s.activeSymbol);
  const tickers      = useStore((s) => s.tickers);
  const paperBalance = useStore((s) => s.paperBalance);
  const venueMode    = useStore((s) => s.venueMode);
  const dangerous    = useStore((s) => s.settings.dangerous);
  const ticker = tickers[activeSymbol];
  const precision = getPricePrecision(activeSymbol, ticker?.lastPrice);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="status-bar">
      <span className={connection.connected ? "ok" : "warn"}>
        Bybit · {connection.connected ? "Connected" : "Connecting…"}
      </span>
      <span className="sep-dot">·</span>
      <span>Latency: {connection.latencyMs !== null ? `${connection.latencyMs} ms` : "— ms"}</span>
      <span className="sep-dot">·</span>
      <span className={`venue-badge venue-${venueMode}`} title="Активный режим исполнения">{venueLabel(venueMode)}</span>
      {dangerous.shiftClickOrderbook && (
        <>
          <span className="sep-dot">·</span>
          <span className={`shift-badge${venueMode === "live" ? " live" : ""}`}
                title="⚡ Shift+клик в стакане отправляет market без подтверждения. Клик → Settings.">
            ⚡ shift-click
          </span>
        </>
      )}
      <span className="sep-dot">·</span>
      <span>Баланс: {fmtUsdt(paperBalance)} USDT</span>
      {ticker && (
        <>
          <span className="sep-dot">·</span>
          <span>{activeSymbol}: <span style={{ color: ticker.change24h >= 0 ? "var(--green)" : "var(--red)" }}>
            {fmtPrice(ticker.lastPrice, precision)}
          </span></span>
        </>
      )}
      <span className="spacer" />
      <span>{now.toLocaleTimeString("ru-RU", { hour12: false })}</span>
      <span className="sep-dot">·</span>
      <span>v0.2.0</span>
    </div>
  );
}
