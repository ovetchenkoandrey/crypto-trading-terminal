import { useEffect, useRef, useState } from "react";
import { DEFAULT_SYMBOLS, TIMEFRAMES } from "../lib/symbols";

interface Props {
  currentSymbol: string;
  currentTimeframe: string;
  onSelect: (symbol: string) => void;
  onSelectTf: (tf: string) => void;
  onCancel: () => void;
}

export function SymbolPicker({ currentSymbol, currentTimeframe, onSelect, onSelectTf, onCancel }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const filtered = DEFAULT_SYMBOLS.filter((s) =>
    s.symbol.includes(query.toUpperCase()) || s.base.toUpperCase().includes(query.toUpperCase())
  );

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="symbol-picker">
        <div className="symbol-picker-head">
          <input
            ref={inputRef}
            className="symbol-picker-search"
            placeholder="Поиск символа..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="symbol-picker-list">
          {filtered.map((s) => (
            <div
              key={s.symbol}
              className={"symbol-picker-row" + (s.symbol === currentSymbol ? " active" : "")}
              onClick={() => onSelect(s.symbol)}
            >
              <span className="sp-sym">{s.symbol}</span>
              <span className="sp-base">{s.base} / {s.quote}</span>
            </div>
          ))}
          {filtered.length === 0 && <div className="sp-empty">Ничего не найдено</div>}
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
