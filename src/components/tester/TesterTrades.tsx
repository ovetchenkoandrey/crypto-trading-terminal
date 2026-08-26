// Trade list with two-way navigation to the chart.
//
// Click a row → the chart centres on that trade. Click a trade on the chart →
// the row scrolls into view and highlights. That round trip is the single most
// used move when you are working out why a run behaved the way it did, so it
// gets a dedicated nonce in the store rather than a "scroll if you feel like it".

import { useEffect, useMemo, useRef, useState } from "react";
import { useTesterStore, type TradeSortKey } from "../../lib/backtest/store";
import type { PaperTrade } from "../../lib/store";
import { buildTradeRows, filterTrades, sortTrades, fmtDuration, fmtStamp, fmtSigned } from "./model";
import { fmtPrice } from "../../lib/format";
import { getPricePrecision } from "../../lib/symbols";

const PAGE = 300;

const COLUMNS: { key: TradeSortKey; label: string; align?: "right" }[] = [
  { key: "index",      label: "#" },
  { key: "entryTs",    label: "Вход" },
  { key: "ts",         label: "Выход" },
  { key: "side",       label: "Сторона" },
  { key: "qty",        label: "Объём",      align: "right" },
  { key: "entryPrice", label: "Цена входа", align: "right" },
  { key: "exitPrice",  label: "Цена выхода", align: "right" },
  { key: "hold",       label: "Длительность", align: "right" },
  { key: "pnl",        label: "P/L",        align: "right" },
];

export function TesterTrades({ trades, symbol }: { trades: readonly PaperTrade[]; symbol: string }) {
  const view    = useTesterStore((s) => s.view);
  const select  = useTesterStore((s) => s.selectTrade);
  const setFilter = useTesterStore((s) => s.setFilter);
  const toggleSort = useTesterStore((s) => s.toggleSort);
  const [limit, setLimit] = useState(PAGE);
  const bodyRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildTradeRows(trades), [trades]);
  const shown = useMemo(
    () => sortTrades(filterTrades(rows, view.filter), view.sortKey, view.sortDir),
    [rows, view.filter, view.sortKey, view.sortDir],
  );

  // A selection coming from the chart may land past the rendered slice — grow
  // the slice rather than silently failing to reveal the row.
  useEffect(() => {
    if (!view.selectedTradeId) return;
    const idx = shown.findIndex((t) => t.id === view.selectedTradeId);
    if (idx >= 0 && idx >= limit) setLimit(idx + 50);
  }, [view.selectedTradeId, view.revealNonce, shown, limit]);

  useEffect(() => {
    if (!view.selectedTradeId || view.revealNonce === 0) return;
    const node = bodyRef.current?.querySelector(`[data-trade-id="${view.selectedTradeId}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [view.revealNonce, view.selectedTradeId, limit]);

  const precision = getPricePrecision(symbol, rows[0]?.exitPrice ?? 0);
  const counts = useMemo(() => ({
    all: rows.length,
    wins: rows.filter((t) => t.pnl > 0).length,
    losses: rows.filter((t) => t.pnl < 0).length,
  }), [rows]);

  if (rows.length === 0) {
    return <div className="tester-empty">Сделок нет — стратегия не открыла ни одной позиции.</div>;
  }

  return (
    <div className="tester-trades-wrap" data-testid="tester-trades">
      <div className="tt-toolbar">
        <div className="tester-seg">
          <button data-testid="tt-filter-all"    className={view.filter === "all" ? "active" : ""}    onClick={() => setFilter("all")}>Все · {counts.all}</button>
          <button data-testid="tt-filter-wins"   className={view.filter === "wins" ? "active" : ""}   onClick={() => setFilter("wins")}>Прибыльные · {counts.wins}</button>
          <button data-testid="tt-filter-losses" className={view.filter === "losses" ? "active" : ""} onClick={() => setFilter("losses")}>Убыточные · {counts.losses}</button>
        </div>
        <span className="dim">клик по строке — график прыгнет к сделке</span>
      </div>

      <div className="tt-body" ref={bodyRef}>
        <table className="tester-trades">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key}
                    data-testid={`tt-sort-${c.key}`}
                    className={"sortable" + (view.sortKey === c.key ? " sorted" : "") + (c.align === "right" ? " r" : "")}
                    onClick={() => toggleSort(c.key)}>
                  {c.label}
                  {view.sortKey === c.key && <span className="arrow">{view.sortDir === "asc" ? "▲" : "▼"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((t) => (
              <tr key={t.id}
                  data-trade-id={t.id}
                  data-testid={`tt-row-${t.index}`}
                  className={t.id === view.selectedTradeId ? "selected" : ""}
                  onClick={() => select(t.id, { focus: true })}>
                <td>{t.index}</td>
                <td>{fmtStamp(t.entryTs)}</td>
                <td>{fmtStamp(t.exitTs)}</td>
                <td style={{ color: t.side === "buy" ? "var(--green)" : "var(--red)" }}>{t.side.toUpperCase()}</td>
                <td className="r">{t.qty}</td>
                <td className="r">{fmtPrice(t.entryPrice, precision)}</td>
                <td className="r">{fmtPrice(t.exitPrice, precision)}</td>
                <td className="r">{fmtDuration(t.holdSec)}</td>
                <td className={"r " + (t.pnl >= 0 ? "pnl-pos" : "pnl-neg")}>{fmtSigned(t.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > limit && (
          <div className="tt-more">
            <button data-testid="tt-more" className="pbtn ghost" onClick={() => setLimit((n) => n + PAGE)}>
              Показать ещё {Math.min(PAGE, shown.length - limit)} из {shown.length - limit}
            </button>
          </div>
        )}
        <div className="rep-note">
          Причина выхода (цель / стоп / конец прогона) в записи сделки пока не хранится —
          движок её не отдаёт, колонка появится вместе с полем в PaperTrade.
        </div>
      </div>
    </div>
  );
}
