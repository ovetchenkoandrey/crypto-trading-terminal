interface OrderBookProps {
  symbol: string;
  lastPrice?: number;
}

interface Level {
  p: number;
  q: number;
  t: number;
}

function buildBook(mid: number): { asks: Level[]; bids: Level[]; maxQ: number } {
  let s = 7;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const asks: Level[] = [];
  const bids: Level[] = [];
  for (let i = 0; i < 11; i++) {
    const p = mid + (i + 1) * (0.4 + rnd() * 0.8);
    const q = 0.05 + rnd() * 2.4;
    asks.push({ p, q, t: p * q });
  }
  for (let i = 0; i < 11; i++) {
    const p = mid - 0.4 - i * (0.4 + rnd() * 0.8);
    const q = 0.05 + rnd() * 2.4;
    bids.push({ p, q, t: p * q });
  }
  const maxQ = Math.max(...asks.map((x) => x.q), ...bids.map((x) => x.q));
  return { asks, bids, maxQ };
}

export function OrderBook({ symbol, lastPrice }: OrderBookProps) {
  const mid = lastPrice ?? 67980.10;
  const { asks, bids, maxQ } = buildBook(mid);

  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Стакан · {symbol}
        <span className="right">×10</span>
      </div>
      <div className="ob-head">
        <span>Цена</span>
        <span>Размер</span>
        <span>Сумма</span>
      </div>
      <div className="ob-rows asks">
        {asks.map((r, i) => (
          <div
            key={"a" + i}
            className="ob-row ask"
            style={{ "--bar-w": `${(r.q / maxQ * 100).toFixed(0)}%` } as React.CSSProperties}
          >
            <span className="price">{r.p.toFixed(1)}</span>
            <span className="qty">{r.q.toFixed(3)}</span>
            <span className="total">{(r.t / 1000).toFixed(1)}k</span>
          </div>
        ))}
      </div>
      <div className="ob-spread">
        {mid.toFixed(2)}
        <span className="sub">≈ ${mid.toFixed(2)}</span>
      </div>
      <div className="ob-rows">
        {bids.map((r, i) => (
          <div
            key={"b" + i}
            className="ob-row bid"
            style={{ "--bar-w": `${(r.q / maxQ * 100).toFixed(0)}%` } as React.CSSProperties}
          >
            <span className="price">{r.p.toFixed(1)}</span>
            <span className="qty">{r.q.toFixed(3)}</span>
            <span className="total">{(r.t / 1000).toFixed(1)}k</span>
          </div>
        ))}
      </div>
    </>
  );
}
