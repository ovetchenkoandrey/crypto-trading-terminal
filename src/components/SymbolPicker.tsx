import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { TIMEFRAMES } from "../lib/symbols";

interface Props {
  currentSymbol: string;
  currentTimeframe: string;
  onSelect: (symbol: string) => void;
  onSelectTf: (tf: string) => void;
  onCancel: () => void;
}

type Filter = "all" | "spot" | "linear";

const MAX_VISIBLE = 200;

export function SymbolPicker({ currentSymbol, currentTimeframe, onSelect, onSelectTf, onCancel }: Props) {
  const allSymbols = useStore((s) => s.allSymbols);
  const tickers    = useStore((s) => s.tickers);

  const [query, setQuery]   = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = allSymbols.filter((s) => {
      if (filter !== "all" && s.category !== filter) return false;
      if (!q) return true;
      return s.symbol.includes(q) || s.base.toUpperCase().includes(q) || s.quote.toUpperCase().includes(q);
    });
    return list;
  }, [allSymbols, query, filter]);

  const visible = filtered.slice(0, MAX_VISIBLE);
  const hiddenCount = Math.max(0, filtered.length - MAX_VISIBLE);

  const counts = useMemo(() => {
    let spot = 0, lin = 0;
    for (const s of allSymbols) {
      if (s.category === "spot") spot++; else lin++;
    }
    return { spot, lin };
  }, [allSymbols]);

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="symbol-picker">
        <div className="symbol-picker-head">
          <input
            ref={inputRef}
            className="symbol-picker-search"
            placeholder="Поиск: BTC, ETH, USDT..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="symbol-picker-filter">
            <button className={filter === "all"    ? "active" : ""} onClick={() => setFilter("all")}>
              Все <span className="sp-count">{allSymbols.length}</span>
            </button>
            <button className={filter === "spot"   ? "active" : ""} onClick={() => setFilter("spot")}>
              Spot <span className="sp-count">{counts.spot}</span>
            </button>
            <button className={filter === "linear" ? "active" : ""} onClick={() => setFilter("linear")}>
              Perp <span className="sp-count">{counts.lin}</span>
            </button>
          </div>
        </div>

        <div className="symbol-picker-list">
          {visible.map((s) => {
            const t = tickers[s.symbol];
            return (
              <div
                key={s.category + ":" + s.symbol}
                className={"symbol-picker-row" + (s.symbol === currentSymbol ? " active" : "")}
                onClick={() => onSelect(s.symbol)}
              >
                <span className={"sp-cat " + s.category}>{s.category === "linear" ? "PERP" : "SPOT"}</span>
                <span className="sp-sym">{s.symbol}</span>
                <span className="sp-base">{s.base}/{s.quote}</span>
                <span className="sp-price">
                  {t?.lastPrice ? t.lastPrice.toLocaleString("en-US", { minimumFractionDigits: s.pricePrecision, maximumFractionDigits: s.pricePrecision }) : ""}
                </span>
                <span className={"sp-ch " + (t ? (t.change24h >= 0 ? "up" : "dn") : "")}>
                  {t ? `${t.change24h >= 0 ? "+" : ""}${t.change24h.toFixed(2)}%` : ""}
                </span>
              </div>
            );
          })}
          {visible.length === 0 && <div className="sp-empty">Ничего не найдено</div>}
          {hiddenCount > 0 && (
            <div className="sp-empty" style={{ color: "var(--fg-mute)", fontStyle: "italic" }}>
              … ещё {hiddenCount}, уточните поиск
            </div>
          )}
        </div>

        <div className="symbol-picker-tfs">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              className={"tf-btn" + (tf.value === currentTimeframe ? " active" : "")}
              onClick={() => onSelectTf(tf.value)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
