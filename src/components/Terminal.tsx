import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { fmtPrice, fmtUsdt } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";
import { venue } from "../lib/execution/router";
import { logWarn } from "../lib/eventBus";
import { Tester } from "./tester/Tester";
import { useTesterStore } from "../lib/backtest/store";

type TabKey = "positions" | "orders" | "history" | "alerts" | "journal" | "tester";

export function Terminal() {
  const [tab, setTab] = useState<TabKey>("journal");

  const positions   = useStore((s) => s.paperPositions);
  const allOrders   = useStore((s) => s.paperOrders);
  const history     = useStore((s) => s.paperHistory);
  const journal     = useStore((s) => s.journal);
  const testerState = useTesterStore((s) => s.state);
  const orders     = useMemo(() => allOrders.filter((o) => o.status === "pending"), [allOrders]);

  const testerBadge =
    testerState === "loading" || testerState === "running" ? "▶" :
    testerState === "done"  ? "✓" :
    testerState === "error" ? "!" : undefined;

  const TABS: { key: TabKey; label: string; badge?: number | string }[] = [
    { key: "positions", label: "Позиции",         badge: positions.length },
    { key: "orders",    label: "Открытые ордера", badge: orders.length },
    { key: "history",   label: "История сделок",  badge: history.length },
    { key: "alerts",    label: "Алерты" },
    { key: "journal",   label: "Журнал",          badge: journal.length },
    { key: "tester",    label: "Тестер",          badge: testerBadge },
  ];

  return (
    <div className="terminal">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`term-tab-${t.key}`}
            className={"tab" + (t.key === tab ? " active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge !== undefined && t.badge !== 0 && t.badge !== "" && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="term-content">
        {tab === "positions" && <PositionsTable />}
        {tab === "orders"    && <OrdersTable />}
        {tab === "history"   && <HistoryTable />}
        {tab === "alerts"    && <EmptyPlaceholder label="Алертов нет" />}
        {tab === "journal"   && <Journal />}
        {tab === "tester"    && <Tester />}
      </div>
    </div>
  );
}

function EmptyPlaceholder({ label }: { label: string }) {
  return (
    <div style={{ padding: 24, textAlign: "center", color: "var(--fg-mute)", fontSize: 12 }}>
      {label}
    </div>
  );
}

function PositionsTable() {
  const positions = useStore((s) => s.paperPositions);
  const tickers   = useStore((s) => s.tickers);
  if (positions.length === 0) return <EmptyPlaceholder label="Открытых позиций нет" />;
  const closePosition = (id: string, symbol: string) => {
    if (!window.confirm(`Закрыть позицию ${symbol} по рынку?`)) return;
    try { venue.closePosition(id); }
    catch (err) { logWarn("position", `не удалось закрыть: ${String(err)}`); }
  };
  return (
    <table className="term-table">
      <thead>
        <tr>
          <th>Открыта</th><th>Символ</th><th>Сторона</th>
          <th>Объём</th><th>Цена входа</th><th>Текущая</th>
          <th>P/L, $</th><th>P/L, %</th><th>Бот</th><th></th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const last = tickers[p.symbol]?.lastPrice ?? p.entryPrice;
          const precision = getPricePrecision(p.symbol, last);
          const direction = p.side === "buy" ? 1 : -1;
          const pnl = (last - p.entryPrice) * p.qty * direction;
          const pnlPct = ((last - p.entryPrice) / p.entryPrice) * 100 * direction;
          const cls = pnl >= 0 ? "pnl-pos" : "pnl-neg";
          return (
            <tr key={p.id}>
              <td>{new Date(p.openedTs).toLocaleTimeString("ru-RU", { hour12: false })}</td>
              <td>{p.symbol}</td>
              <td style={{ color: p.side === "buy" ? "var(--green)" : "var(--red)" }}>{p.side}</td>
              <td>{p.qty}</td>
              <td>{fmtPrice(p.entryPrice, precision)}</td>
              <td>{fmtPrice(last, precision)}</td>
              <td className={cls}>{pnl >= 0 ? "+" : ""}{fmtUsdt(pnl)}</td>
              <td className={cls}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%</td>
              <td style={{ color: "var(--fg-dim)" }}>{p.botId ?? "—"}</td>
              <td>
                <button className="row-action danger"
                        onClick={() => closePosition(p.id, p.symbol)}
                        title="Закрыть по рынку">✕ Закрыть</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrdersTable() {
  const allOrders = useStore((s) => s.paperOrders);
  const orders = useMemo(() => allOrders.filter((o) => o.status === "pending"), [allOrders]);
  if (orders.length === 0) return <EmptyPlaceholder label="Активных ордеров нет" />;
  const cancel = (id: string) => {
    try { venue.cancelOrder(id, "user"); }
    catch (err) { logWarn("order", `не удалось отменить: ${String(err)}`); }
  };
  return (
    <table className="term-table">
      <thead>
        <tr>
          <th>Время</th><th>Символ</th><th>Тип</th>
          <th>Сторона</th><th>Цена</th><th>Объём</th><th>Бот</th><th></th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>{new Date(o.ts).toLocaleTimeString("ru-RU", { hour12: false })}</td>
            <td>{o.symbol}</td>
            <td>{o.type}</td>
            <td style={{ color: o.side === "buy" ? "var(--green)" : "var(--red)" }}>{o.side}</td>
            <td>{fmtPrice(o.price, getPricePrecision(o.symbol, o.price))}</td>
            <td>{o.qty}</td>
            <td style={{ color: "var(--fg-dim)" }}>{o.botId ?? "—"}</td>
            <td>
              <button className="row-action danger"
                      onClick={() => cancel(o.id)}
                      title="Отменить ордер">✕ Отменить</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTable() {
  const history = useStore((s) => s.paperHistory);
  if (history.length === 0) return <EmptyPlaceholder label="История сделок пуста" />;
  return (
    <table className="term-table">
      <thead>
        <tr>
          <th>Закрыта</th><th>Символ</th><th>Сторона</th>
          <th>Объём</th><th>Вход</th><th>Выход</th><th>P/L, $</th><th>Бот</th>
        </tr>
      </thead>
      <tbody>
        {history.slice().reverse().map((t) => {
          const precision = getPricePrecision(t.symbol, t.exitPrice);
          const cls = t.pnl >= 0 ? "pnl-pos" : "pnl-neg";
          return (
            <tr key={t.id}>
              <td>{new Date(t.ts).toLocaleTimeString("ru-RU", { hour12: false })}</td>
              <td>{t.symbol}</td>
              <td style={{ color: t.side === "buy" ? "var(--green)" : "var(--red)" }}>{t.side}</td>
              <td>{t.qty}</td>
              <td>{fmtPrice(t.entryPrice, precision)}</td>
              <td>{fmtPrice(t.exitPrice, precision)}</td>
              <td className={cls}>{t.pnl >= 0 ? "+" : ""}{fmtUsdt(t.pnl)}</td>
              <td style={{ color: "var(--fg-dim)" }}>{t.botId ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Journal() {
  const journal = useStore((s) => s.journal);
  const ref = useRef<HTMLDivElement>(null);

  // Autoscroll to bottom on new entries
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [journal.length]);

  if (journal.length === 0) return <EmptyPlaceholder label="Журнал пуст" />;

  return (
    <div className="journal" ref={ref}>
      {journal.slice(-200).map((e, i) => (
        <div key={e.ts + "-" + i} className="jrn">
          <span className="ts">{new Date(e.ts).toLocaleTimeString("ru-RU", { hour12: false })}</span>
          <span className={"lvl " + e.level}>{e.level.toUpperCase()}</span>
          <span className="msg"><span className="h">[{e.source}]</span> {e.msg}</span>
        </div>
      ))}
    </div>
  );
}
