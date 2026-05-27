import { useStore } from "../lib/store";
import { fmtPrice, fmtPercent } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";

export function MarketWatch() {
  const watchlist = useStore((s) => s.watchlist);
  const tickers   = useStore((s) => s.tickers);
  const activeSym = useStore((s) => s.activeSymbol);
  const setActive = useStore((s) => s.setActiveSymbol);

  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Обзор рынка
        <span className="right">Bybit Spot</span>
      </div>
      <div className="mw-head">
        <span>Символ</span>
        <span className="num">Цена</span>
        <span className="num">24h%</span>
      </div>
      <div className="mw-list">
        {watchlist.map((sym) => {
          const t = tickers[sym];
          const precision = getPricePrecision(sym, t?.lastPrice);
          const dir = t ? (t.change24h >= 0 ? "up" : "dn") : "none";
          return (
            <div
              key={sym}
              className={"mw-row" + (sym === activeSym ? " active" : "")}
              onClick={() => setActive(sym)}
              title={`Двойной клик — открыть ${sym}`}
            >
              <span className="sym">{sym}</span>
              <span className={"bid mw-price " + dir}>
                {t ? fmtPrice(t.lastPrice, precision) : "—"}
              </span>
              <span className={"ask mw-ch " + dir}>
                {t ? fmtPercent(t.change24h) : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}
