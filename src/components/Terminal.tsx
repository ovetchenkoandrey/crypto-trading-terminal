import { useState } from "react";

type TabKey = "positions" | "orders" | "history" | "alerts" | "journal";

const TABS: { key: TabKey; label: string; badge?: string }[] = [
  { key: "positions", label: "Позиции",          badge: "3" },
  { key: "orders",    label: "Открытые ордера",  badge: "2" },
  { key: "history",   label: "История сделок" },
  { key: "alerts",    label: "Алерты",           badge: "1" },
  { key: "journal",   label: "Журнал" },
];

const JOURNAL: [string, "ok" | "info" | "warn" | "error", string][] = [
  ["14:32:18", "ok",    `<span class="h">[bybit-rest]</span> /v5/market/kline → OK, 200 candles received for BTCUSDT.15`],
  ["14:32:14", "info",  `<span class="h">[chart]</span> ChartPane mounted, rendered 200 candles`],
  ["14:32:01", "ok",    `<span class="h">[app]</span> приложение запущено, версия 0.1.0`],
  ["14:32:00", "info",  `<span class="h">[bybit-rest]</span> запрос свечей: symbol=BTCUSDT interval=15 limit=200`],
  ["14:31:59", "info",  `<span class="h">[ui]</span> MainWindow построен, layout=1×1`],
];

export function Terminal() {
  const [tab, setTab] = useState<TabKey>("journal");

  return (
    <div className="terminal">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={"tab" + (t.key === tab ? " active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="term-content">
        {tab === "positions" && <PositionsTable />}
        {tab === "orders" && <OrdersTable />}
        {tab === "history" && <HistoryTable />}
        {tab === "alerts" && <AlertsTable />}
        {tab === "journal" && <Journal />}
      </div>
    </div>
  );
}

function PositionsTable() {
  return (
    <table className="term-table">
      <thead>
        <tr>
          <th>Время</th><th>Символ</th><th>Тип</th>
          <th>Объём</th><th>Цена входа</th>
          <th>S/L</th><th>T/P</th>
          <th>Текущая</th><th>P/L, $</th><th>P/L, %</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>14:32:18</td><td>BTCUSDT</td><td style={{ color: "var(--green)" }}>buy</td>
          <td>0.05</td><td>67 432.50</td><td>66 800.00</td><td>68 500.00</td>
          <td>67 980.10</td><td className="pnl-pos">+27.38</td><td className="pnl-pos">+0.81%</td>
        </tr>
        <tr>
          <td>12:08:44</td><td>ETHUSDT</td><td style={{ color: "var(--red)" }}>sell</td>
          <td>0.30</td><td>3 845.20</td><td>3 900.00</td><td>3 750.00</td>
          <td>3 821.50</td><td className="pnl-pos">+7.11</td><td className="pnl-pos">+0.62%</td>
        </tr>
        <tr>
          <td>09:51:02</td><td>SOLUSDT</td><td style={{ color: "var(--green)" }}>buy</td>
          <td>2.5</td><td>168.40</td><td>165.00</td><td>175.00</td>
          <td>166.85</td><td className="pnl-neg">-3.88</td><td className="pnl-neg">-0.92%</td>
        </tr>
      </tbody>
    </table>
  );
}

function OrdersTable() {
  return (
    <table className="term-table">
      <thead><tr>
        <th>Время</th><th>Символ</th><th>Тип</th><th>Сторона</th>
        <th>Цена</th><th>Размер</th><th>Статус</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>14:31:50</td><td>BTCUSDT</td><td>Limit</td>
          <td style={{ color: "var(--green)" }}>buy</td>
          <td>67 200.00</td><td>0.02</td>
          <td style={{ color: "var(--accent)" }}>Pending</td>
        </tr>
        <tr>
          <td>11:14:22</td><td>ETHUSDT</td><td>Stop</td>
          <td style={{ color: "var(--red)" }}>sell</td>
          <td>3 900.00</td><td>0.30</td>
          <td style={{ color: "var(--accent)" }}>Pending</td>
        </tr>
      </tbody>
    </table>
  );
}

function HistoryTable() {
  return (
    <table className="term-table">
      <thead><tr>
        <th>Закрыт</th><th>Символ</th><th>Тип</th>
        <th>Объём</th><th>Вход</th><th>Выход</th><th>P/L, $</th>
      </tr></thead>
      <tbody>
        <tr>
          <td>27.05 19:14</td><td>BTCUSDT</td>
          <td style={{ color: "var(--green)" }}>buy</td>
          <td>0.10</td><td>66 100.00</td><td>67 450.00</td>
          <td className="pnl-pos">+135.00</td>
        </tr>
        <tr>
          <td>27.05 11:32</td><td>SOLUSDT</td>
          <td style={{ color: "var(--red)" }}>sell</td>
          <td>5.0</td><td>171.20</td><td>168.80</td>
          <td className="pnl-pos">+12.00</td>
        </tr>
      </tbody>
    </table>
  );
}

function AlertsTable() {
  return (
    <table className="term-table">
      <thead><tr><th>Создан</th><th>Символ</th><th>Условие</th><th>Состояние</th></tr></thead>
      <tbody>
        <tr>
          <td>14:00:00</td><td>BTCUSDT</td><td>{"Цена > 68 500.00"}</td>
          <td style={{ color: "var(--accent)" }}>Ожидание</td>
        </tr>
        <tr>
          <td>13:42:15</td><td>SOLUSDT</td><td>{"RSI(14) < 30"}</td>
          <td style={{ color: "var(--green)" }}>Сработал в 14:18</td>
        </tr>
      </tbody>
    </table>
  );
}

function Journal() {
  return (
    <div className="journal">
      {JOURNAL.map(([ts, lvl, msg], i) => (
        <div key={i} className="jrn">
          <span className="ts">{ts}</span>
          <span className={"lvl " + lvl}>{lvl.toUpperCase()}</span>
          <span className="msg" dangerouslySetInnerHTML={{ __html: msg }} />
        </div>
      ))}
    </div>
  );
}
