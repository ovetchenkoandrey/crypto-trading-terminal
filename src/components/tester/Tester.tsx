// Strategy Tester — the "Тестер" tab in the Terminal.
// Renders a different sub-view depending on the tester store state:
//   idle / error → form
//   loading      → "Загрузка истории…" with progress
//   running      → progress bar + live stats + cancel button
//   done         → results (stats + equity + trades table)

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../lib/store";
import { useTesterStore, type TesterFormParams } from "../../lib/backtest/store";
import { startBacktestFromForm } from "../../lib/backtest/driver";
import { TIMEFRAMES } from "../../lib/symbols";
import { fmtUsdt, fmtPrice } from "../../lib/format";
import { getPricePrecision } from "../../lib/symbols";

export function Tester() {
  const state = useTesterStore((s) => s.state);
  switch (state) {
    case "loading":
    case "running": return <TesterRunning />;
    case "done":    return <TesterResults />;
    case "error":   return <TesterError />;
    default:        return <TesterForm />;
  }
}

// ─── form ─────────────────────────────────────────────────────────────────

function defaultForm(): TesterFormParams {
  const now = Math.floor(Date.now() / 1000);
  return {
    botId: "",
    symbol: "BTCUSDT",
    interval: "15",
    rangePreset: "30d",
    fromSec: now - 30 * 86400,
    toSec: now,
    initialBalance: 10_000,
    mode: "background",
    speed: 50,
  };
}

function TesterForm() {
  const bots       = useStore((s) => s.botConfigs);
  const lastParams = useTesterStore((s) => s.lastParams);
  const [form, setForm] = useState<TesterFormParams>(lastParams ?? defaultForm());

  // Keep botId valid even if persisted last-params point to a deleted bot
  useEffect(() => {
    if (bots.length > 0 && !bots.some((b) => b.id === form.botId)) {
      setForm((f) => ({ ...f, botId: bots[0].id }));
    }
  }, [bots, form.botId]);

  const upd = (patch: Partial<TesterFormParams>) => setForm((f) => ({ ...f, ...patch }));

  const start = () => {
    if (!form.botId) return;
    useTesterStore.getState().setLastParams(form);
    startBacktestFromForm(form);
  };

  const dateFromInput = (s: string): number => Math.floor(new Date(s + "T00:00:00Z").getTime() / 1000);
  const inputFromDate = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

  return (
    <div className="tester-body">
      {bots.length === 0 && (
        <div className="tester-empty">
          Нет настроенных ботов. Создай в Навигаторе (например, Grid Bot или DCA Strategy).
        </div>
      )}

      <div className="tester-form">
        <div className="tf-col">
          <Field label="Стратегия">
            <select value={form.botId} onChange={(e) => upd({ botId: e.target.value })}>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>{b.kind} · {b.symbol}</option>
              ))}
              {bots.length === 0 && <option>—</option>}
            </select>
          </Field>
          <Field label="Символ">
            <input value={form.symbol} onChange={(e) => upd({ symbol: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Таймфрейм">
            <select value={form.interval} onChange={(e) => upd({ interval: e.target.value as TesterFormParams["interval"] })}>
              {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>

        <div className="tf-col">
          <Field label="Диапазон">
            <select value={form.rangePreset} onChange={(e) => upd({ rangePreset: e.target.value as TesterFormParams["rangePreset"] })}>
              <option value="7d">Последние 7 дней</option>
              <option value="30d">Последние 30 дней</option>
              <option value="90d">Последние 90 дней</option>
              <option value="365d">Последние 365 дней</option>
              <option value="custom">Кастомно…</option>
            </select>
          </Field>
          {form.rangePreset === "custom" && (
            <>
              <Field label="От">
                <input type="date" value={inputFromDate(form.fromSec)} onChange={(e) => upd({ fromSec: dateFromInput(e.target.value) })} />
              </Field>
              <Field label="До">
                <input type="date" value={inputFromDate(form.toSec)} onChange={(e) => upd({ toSec: dateFromInput(e.target.value) })} />
              </Field>
            </>
          )}
          <Field label="Стартовый баланс (USDT)">
            <input type="number" value={form.initialBalance} onChange={(e) => upd({ initialBalance: +e.target.value || 0 })} />
          </Field>
        </div>

        <div className="tf-col">
          <Field label="Режим">
            <div className="tester-mode-strip">
              <button data-testid="tester-mode-bg"
                      className={form.mode === "background" ? "active" : ""}
                      onClick={() => upd({ mode: "background" })}>
                <div className="lbl">⚡ Фоновый</div>
                <div className="desc">Без визуала, быстро. Только итог.</div>
              </button>
              <button data-testid="tester-mode-visual"
                      className={form.mode === "visual" ? "active" : ""}
                      onClick={() => upd({ mode: "visual" })}>
                <div className="lbl">▶ Визуальный</div>
                <div className="desc">Чарт сверху проигрывает свечи.</div>
              </button>
            </div>
          </Field>
          {form.mode === "visual" && (
            <Field label="Скорость">
              <div className="tester-seg">
                {([1, 10, 50, 0] as const).map((sp) => (
                  <button key={sp}
                          className={form.speed === sp ? "active" : ""}
                          onClick={() => upd({ speed: sp })}>
                    {sp === 0 ? "Max" : `${sp}×`}
                  </button>
                ))}
              </div>
            </Field>
          )}
        </div>
      </div>

      <div className="tester-controls">
        <button data-testid="tester-start" className="pbtn primary"
                disabled={!form.botId || bots.length === 0}
                onClick={start}>
          ▶ Start
        </button>
        <span className="dim">
          Slippage и комиссия — из Settings → Paper trading.
        </span>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tf-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

// ─── running / loading ────────────────────────────────────────────────────

function TesterRunning() {
  const state    = useTesterStore((s) => s.state);
  const run      = useTesterStore((s) => s.run);
  const cancel   = useTesterStore((s) => s.requestCancel);

  const loadPct = run.loadProgress && run.loadProgress.estimated > 0
    ? Math.min(100, (run.loadProgress.loaded / run.loadProgress.estimated) * 100)
    : 0;
  const runPct = run.runProgress && run.runProgress.total > 0
    ? (run.runProgress.index / run.runProgress.total) * 100
    : 0;

  const elapsedSec = Math.floor((Date.now() - run.startedAt) / 1000);

  return (
    <div className="tester-body">
      <div className="tester-running-head">
        <b>{state === "loading" ? "Загрузка истории" : "Прогон"}</b>
        <span className="dim">прошло {elapsedSec}с</span>
      </div>

      {state === "loading" && (
        <div className="tester-progress">
          <div className="row"><span className="dim">{loadPct.toFixed(0)}% · {run.loadProgress?.loaded ?? 0} / {run.loadProgress?.estimated ?? 0} свечей</span></div>
          <div className="pbar"><div style={{ width: loadPct + "%" }} /></div>
        </div>
      )}

      {state === "running" && run.runProgress && (
        <>
          <div className="tester-progress">
            <div className="row">
              <span className="dim">{runPct.toFixed(0)}% · {run.runProgress.index} / {run.runProgress.total} свечей</span>
            </div>
            <div className="pbar"><div style={{ width: runPct + "%" }} /></div>
          </div>

          <div className="tester-live-stats">
            <Stat label="Сделок"   value={String(run.runProgress.trades)} />
            <Stat label="Equity"   value={fmtUsdt(run.runProgress.equity)} mode={run.runProgress.equity >= 0 ? "pos" : "neg"} />
            <Stat label="Balance"  value={fmtUsdt(run.runProgress.balance)} />
          </div>
        </>
      )}

      <div className="tester-controls">
        <button data-testid="tester-cancel" className="pbtn danger" onClick={cancel}>⏹ Cancel</button>
      </div>
    </div>
  );
}

function Stat({ label, value, mode }: { label: string; value: string; mode?: "pos" | "neg" }) {
  const cls = mode === "pos" ? "pnl-pos" : mode === "neg" ? "pnl-neg" : "";
  return (
    <div className="tester-stat">
      <div className="lbl">{label}</div>
      <div className={"val " + cls}>{value}</div>
    </div>
  );
}

// ─── results ──────────────────────────────────────────────────────────────

function TesterResults() {
  const run    = useTesterStore((s) => s.run);
  const reset  = useTesterStore((s) => s.reset);
  if (!run.result) return null;
  const r = run.result;
  const s = r.stats;
  const elapsedSec = run.finishedAt ? Math.floor((run.finishedAt - run.startedAt) / 1000) : 0;

  return (
    <div className="tester-body">
      <div className="tester-controls" style={{ marginBottom: 12 }}>
        <button data-testid="tester-run-again" className="pbtn primary" onClick={() => startBacktestFromForm(r.params as never)}>
          ▶ Run again
        </button>
        <button data-testid="tester-edit" className="pbtn ghost" onClick={reset}>
          Edit settings
        </button>
        <span className="dim">Завершено за {elapsedSec}с · {r.stats.trades} сделок</span>
      </div>

      <div className="tester-results">
        <div className="tester-stats-block">
          <h3>Сводка</h3>
          <StatRow k="Net profit" v={`${s.netProfit >= 0 ? "+" : ""}${fmtUsdt(s.netProfit)} (${s.netProfitPct >= 0 ? "+" : ""}${s.netProfitPct.toFixed(2)}%)`} mode={s.netProfit >= 0 ? "pos" : "neg"} />
          <StatRow k="Сделок" v={`${s.trades} (${s.wins}W / ${s.losses}L)`} />
          <StatRow k="Win rate" v={`${(s.winRate * 100).toFixed(1)}%`} mode={s.winRate >= 0.5 ? "pos" : "neg"} />
          <StatRow k="Profit factor" v={Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"} />
          <StatRow k="Max drawdown" v={`-${fmtUsdt(s.maxDrawdown)} (-${s.maxDrawdownPct.toFixed(2)}%)`} mode="neg" />
          <StatRow k="Avg trade" v={`${s.avgTrade >= 0 ? "+" : ""}${fmtUsdt(s.avgTrade)}`} />
          <StatRow k="Avg win / loss" v={`${fmtUsdt(s.avgWin)} / ${fmtUsdt(s.avgLoss)}`} />
          <StatRow k="Sharpe (дневной)" v={s.sharpeDaily.toFixed(2)} />
        </div>
        <EquityCurve equity={r.equity} initial={r.params.initialBalance} />
      </div>

      <TradesTable trades={r.trades} symbol={r.params.symbol} />
    </div>
  );
}

function StatRow({ k, v, mode }: { k: string; v: string; mode?: "pos" | "neg" }) {
  const cls = mode === "pos" ? "pnl-pos" : mode === "neg" ? "pnl-neg" : "";
  return (
    <div className="stat-row"><span className="k">{k}</span><span className={"v " + cls}>{v}</span></div>
  );
}

function EquityCurve({ equity, initial }: { equity: { time: number; equity: number }[]; initial: number }) {
  const points = useMemo(() => {
    if (equity.length === 0) return "";
    const min = Math.min(initial, ...equity.map((e) => e.equity));
    const max = Math.max(initial, ...equity.map((e) => e.equity));
    const span = Math.max(1, max - min);
    return equity.map((e, i) => {
      const x = (i / (equity.length - 1 || 1)) * 400;
      const y = 180 - ((e.equity - min) / span) * 170;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  }, [equity, initial]);

  const final = equity.length ? equity[equity.length - 1].equity : initial;
  const profitable = final >= initial;
  const color = profitable ? "#3cc85a" : "#dc3c3c";

  return (
    <div className="tester-equity">
      <div className="eq-head">
        <span>Equity curve</span>
        <span style={{ color }}>{fmtUsdt(final)} USDT</span>
      </div>
      {equity.length > 1 ? (
        <svg viewBox="0 0 400 184" preserveAspectRatio="none">
          <polyline points={points} stroke={color} strokeWidth="1.5" fill="none" />
        </svg>
      ) : (
        <div className="eq-empty">Нет данных для графика</div>
      )}
    </div>
  );
}

function TradesTable({ trades, symbol }: { trades: { id: string; ts: number; side: string; entryPrice: number; exitPrice: number; qty: number; pnl: number }[]; symbol: string }) {
  if (trades.length === 0) {
    return <div className="tester-empty" style={{ marginTop: 12 }}>Сделок нет</div>;
  }
  const precision = getPricePrecision(symbol, trades[0].exitPrice);
  return (
    <table className="tester-trades">
      <thead>
        <tr>
          <th>#</th><th>Закрыта</th><th>Сторона</th>
          <th>Вход</th><th>Выход</th><th>Объём</th><th>P/L</th>
        </tr>
      </thead>
      <tbody>
        {trades.slice(0, 50).map((t, i) => (
          <tr key={t.id}>
            <td>{i + 1}</td>
            <td>{new Date(t.ts).toISOString().slice(0, 16).replace("T", " ")}</td>
            <td style={{ color: t.side === "buy" ? "var(--green)" : "var(--red)" }}>{t.side.toUpperCase()}</td>
            <td>{fmtPrice(t.entryPrice, precision)}</td>
            <td>{fmtPrice(t.exitPrice, precision)}</td>
            <td>{t.qty}</td>
            <td className={t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{t.pnl >= 0 ? "+" : ""}{fmtUsdt(t.pnl)}</td>
          </tr>
        ))}
        {trades.length > 50 && (
          <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--fg-mute)" }}>… и ещё {trades.length - 50}</td></tr>
        )}
      </tbody>
    </table>
  );
}

// ─── error ────────────────────────────────────────────────────────────────

function TesterError() {
  const err   = useTesterStore((s) => s.run.error);
  const reset = useTesterStore((s) => s.reset);
  return (
    <div className="tester-body">
      <div className="tester-error">
        <b>Ошибка прогона:</b> {err}
      </div>
      <div className="tester-controls">
        <button className="pbtn ghost" onClick={reset}>Назад к форме</button>
      </div>
    </div>
  );
}
