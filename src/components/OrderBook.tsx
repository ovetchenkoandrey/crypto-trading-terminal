import { useStore } from "../lib/store";
import { fmtPrice, fmtVolume } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";
import { venue } from "../lib/execution/router";
import { logOk, logWarn } from "../lib/eventBus";

const DEPTH = 12;

export function OrderBook() {
  const orderbook  = useStore((s) => s.orderbook);
  const activeSym  = useStore((s) => s.activeSymbol);
  const ticker     = useStore((s) => s.tickers[activeSym]);
  const openPopup  = useStore((s) => s.openOrderPopup);
  const dangerous  = useStore((s) => s.settings.dangerous);
  const lastUsedQty = useStore((s) => s.lastUsedQty);
  const firstShown  = useStore((s) => s.firstShiftClickToastShown);
  const markShown   = useStore((s) => s.markFirstShiftClickToastShown);

  const symbol = orderbook?.symbol ?? activeSym;
  const precision = getPricePrecision(symbol, ticker?.lastPrice);

  if (!orderbook || orderbook.symbol !== activeSym) {
    return (
      <>
        <div className="panel-title">
          <span className="dot" />
          Стакан · {activeSym}
          <span className="right">L2</span>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-mute)", fontSize: 11 }}>
          Ожидание данных…
        </div>
      </>
    );
  }

  const asks = orderbook.asks.slice(0, DEPTH);
  const bids = orderbook.bids.slice(0, DEPTH);

  const maxQ = Math.max(
    1e-9,
    ...asks.map((l) => l.qty),
    ...bids.map((l) => l.qty),
  );

  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : 0;
  const mid = ticker?.lastPrice ?? ((asks[0]?.price ?? 0) + (bids[0]?.price ?? 0)) / 2;
  const dir = ticker ? (ticker.change24h >= 0 ? "up" : "dn") : "up";

  // Click on an ask line → buy that price (you'd be lifting the offer);
  // click on a bid line → sell at that price.
  function handleRowClick(e: React.MouseEvent, price: number, kind: "ask" | "bid", qty: number) {
    void qty;
    const side = kind === "ask" ? "buy" : "sell";

    if (e.shiftKey && dangerous.shiftClickOrderbook) {
      // Quick market — see firstShown for training confirm.
      const useQty = lastUsedQty > 0 ? lastUsedQty : 0.001;
      if (!firstShown) {
        const ok = window.confirm(
          `⚡ Включён shift-click — этот жест отправляет market без подтверждения.\n\n` +
          `Сейчас: ${side.toUpperCase()} ${useQty} ${symbolBase(symbol)} @ market (~${(useQty * price).toFixed(2)} USDT).\n\n` +
          `Дальше — без подтверждений, до отключения опции.`,
        );
        markShown();
        if (!ok) return;
      }
      try {
        venue.placeOrder({ symbol, side, type: "market", price, qty: useQty });
        logOk("order", `⚡ shift-click: ${side} ${useQty} ${symbol} @ market`);
      } catch (err) {
        logWarn("order", `не удалось разместить: ${String(err)}`);
      }
      return;
    }

    // Normal click → open popup anchored to the row, prefilled as Limit @ that price.
    const row = e.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    openPopup(
      {
        symbol,
        side,
        type: "limit",
        price,
        qty: lastUsedQty > 0 ? lastUsedQty : undefined,
        advanced: e.detail >= 2,   // double-click opens advanced
      },
      { x: rect.right - 4, y: rect.top + rect.height / 2 },
    );
  }

  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Стакан · {symbol}
        <span className="right">L2</span>
      </div>
      <div className="ob-subhint">
        <span>клик: <span className="lim">limit</span></span>
        {dangerous.shiftClickOrderbook && (
          <span>· <kbd>⇧</kbd>клик: <span className="mkt">market</span></span>
        )}
        <span>· 2× клик: <span className="lim">расширенно</span></span>
      </div>
      <div className="ob-head">
        <span>Цена</span>
        <span>Размер</span>
        <span>Сумма</span>
      </div>
      <div className="ob-rows asks">
        {asks.map((l) => (
          <div
            key={"a" + l.price}
            className="ob-row ask"
            style={{ "--bar-w": `${(l.qty / maxQ * 100).toFixed(0)}%` } as React.CSSProperties}
            title={`клик → Buy Limit @ ${fmtPrice(l.price, precision)}` +
                   (dangerous.shiftClickOrderbook
                     ? ` · ⇧клик → Market Buy ${lastUsedQty || 0.001} ⚡`
                     : "")}
            onClick={(e) => handleRowClick(e, l.price, "ask", l.qty)}
          >
            <span className="price">{fmtPrice(l.price, precision)}</span>
            <span className="qty">{l.qty.toFixed(4)}</span>
            <span className="total">{fmtVolume(l.price * l.qty)}</span>
          </div>
        ))}
      </div>
      <div className={"ob-spread " + dir}>
        <span style={{ color: dir === "up" ? "var(--green)" : "var(--red)" }}>
          {fmtPrice(mid, precision)}
        </span>
        <span className="sub">spread {spread.toFixed(precision)}</span>
      </div>
      <div className="ob-rows">
        {bids.map((l) => (
          <div
            key={"b" + l.price}
            className="ob-row bid"
            style={{ "--bar-w": `${(l.qty / maxQ * 100).toFixed(0)}%` } as React.CSSProperties}
            title={`клик → Sell Limit @ ${fmtPrice(l.price, precision)}` +
                   (dangerous.shiftClickOrderbook
                     ? ` · ⇧клик → Market Sell ${lastUsedQty || 0.001} ⚡`
                     : "")}
            onClick={(e) => handleRowClick(e, l.price, "bid", l.qty)}
          >
            <span className="price">{fmtPrice(l.price, precision)}</span>
            <span className="qty">{l.qty.toFixed(4)}</span>
            <span className="total">{fmtVolume(l.price * l.qty)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function symbolBase(symbol: string): string {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4);
  if (symbol.endsWith("USDC")) return symbol.slice(0, -4);
  if (symbol.endsWith("USD"))  return symbol.slice(0, -3);
  return symbol;
}
