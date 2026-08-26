// Strategy Tester — the "Тестер" tab in the Terminal.
// Renders a different sub-view depending on the tester store state:
//   idle / error → form
//   loading      → "Загрузка истории…" with progress
//   running      → progress bar + live stats + cancel button
//   done         → results (stats + equity + trades table)

import { useEffect, useState } from "react";
import { useStore } from "../../lib/store";
import { useTesterStore, type TesterFormParams } from "../../lib/backtest/store";
import { startBacktestFromForm } from "../../lib/backtest/driver";
import { TIMEFRAMES } from "../../lib/symbols";
import { fmtUsdt } from "../../lib/format";
import { TesterReport } from "./TesterReport";
import { TesterTrades } from "./TesterTrades";

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
    const ts = useTesterStore.getState();
    ts.setLastParams(form);
    // The cell the user is looking at is the cell that plays the run.
    ts.showOnChart(useStore.getState().activeCellIndex);
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
  const run        = useTesterStore((s) => s.run);
  const reset      = useTesterStore((s) => s.reset);
  const lastParams = useTesterStore((s) => s.lastParams);
  const onChart    = useTesterStore((s) => s.view.onChart);
  const activeCell = useStore((s) => s.activeCellIndex);
  if (!run.result) return null;
  const r = run.result;
  const s = r.stats;
  const durationMs = run.finishedAt ? run.finishedAt - run.startedAt : 0;

  return (
    <div className="tester-body tester-done">
      <div className="tester-controls tester-done-bar">
        <button data-testid="tester-run-again" className="pbtn primary"
                disabled={!lastParams}
                onClick={() => lastParams && startBacktestFromForm(lastParams)}>
          ▶ Повторить
        </button>
        <button data-testid="tester-edit" className="pbtn ghost" onClick={reset}>
          Настройки
        </button>
        <button data-testid="tester-toggle-chart" className={"pbtn " + (onChart ? "ghost" : "primary")}
                onClick={() => {
                  const st = useTesterStore.getState();
                  if (st.view.onChart) st.hideChart();
                  else st.showOnChart(activeCell);
                }}>
          {onChart ? "Убрать с графика" : "Показать на графике"}
        </button>
        <span className={"tester-headline " + (s.netProfit >= 0 ? "pnl-pos" : "pnl-neg")}>
          {s.netProfit >= 0 ? "+" : "−"}{fmtUsdt(Math.abs(s.netProfit))} USDT
        </span>
        <span className="dim">
          {s.trades} сделок · прогон за {Math.max(1, Math.round(durationMs / 1000))}с
        </span>
      </div>

      <div className="tester-done-grid">
        <div className="tdg-left">
          <TesterReport result={r} durationMs={durationMs} />
        </div>
        <div className="tdg-right">
          <TesterTrades trades={r.trades} symbol={r.params.symbol} />
        </div>
      </div>
    </div>
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
