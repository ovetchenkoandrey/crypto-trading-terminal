import { useStore } from "../lib/store";
import { fmtPrice, fmtVolume } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";

const DEPTH = 12;

export function OrderBook() {
  const orderbook  = useStore((s) => s.orderbook);
  const activeSym  = useStore((s) => s.activeSymbol);
  const ticker     = useStore((s) => s.tickers[activeSym]);

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

  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Стакан · {symbol}
        <span className="right">L2</span>
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
