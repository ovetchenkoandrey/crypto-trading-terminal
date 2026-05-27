interface SymbolRow {
  sym: string;
  bid: number;
  ask: number;
}

const SYMBOLS: SymbolRow[] = [
  { sym: "BTCUSDT",  bid: 67978.50, ask: 67980.10 },
  { sym: "ETHUSDT",  bid: 3820.75,  ask: 3821.50 },
  { sym: "SOLUSDT",  bid: 166.82,   ask: 166.85 },
  { sym: "BNBUSDT",  bid: 612.20,   ask: 612.30 },
  { sym: "XRPUSDT",  bid: 0.5421,   ask: 0.5423 },
  { sym: "DOGEUSDT", bid: 0.1382,   ask: 0.1384 },
  { sym: "ADAUSDT",  bid: 0.4581,   ask: 0.4583 },
  { sym: "AVAXUSDT", bid: 36.21,    ask: 36.25 },
  { sym: "DOTUSDT",  bid: 7.82,     ask: 7.84 },
  { sym: "LINKUSDT", bid: 14.55,    ask: 14.57 },
  { sym: "MATICUSDT",bid: 0.7421,   ask: 0.7425 },
  { sym: "ATOMUSDT", bid: 8.14,     ask: 8.16 },
];

function fmt(p: number): string {
  const d = p < 1 ? 4 : p < 100 ? 2 : 1;
  return p.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

interface MarketWatchProps {
  activeSymbol: string;
}

export function MarketWatch({ activeSymbol }: MarketWatchProps) {
  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Обзор рынка
        <span className="right">Bybit</span>
      </div>
      <div className="mw-head">
        <span>Символ</span>
        <span className="num">Bid</span>
        <span className="num">Ask</span>
      </div>
      <div className="mw-list">
        {SYMBOLS.map((s) => (
          <div key={s.sym} className={"mw-row" + (s.sym === activeSymbol ? " active" : "")}>
            <span className="sym">{s.sym}</span>
            <span className="bid">{fmt(s.bid)}</span>
            <span className="ask">{fmt(s.ask)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
