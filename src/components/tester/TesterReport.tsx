// Report panel. Every number here comes out of lib/backtest/report.ts — the
// same builder the CLI prints — so a screenshot of this panel and a text report
// of the same run can be compared line by line.

import { useMemo } from "react";
import type { BacktestResult } from "../../lib/execution/backtest/runner";
import type { BacktestReport, CriterionCheck } from "../../lib/backtest/report";
import { buildUiReport, fmtDuration, fmtSigned } from "./model";
import { fmtUsdt } from "../../lib/format";

interface Props {
  result: BacktestResult;
  durationMs: number;
}

export function TesterReport({ result, durationMs }: Props) {
  const report = useMemo(() => buildUiReport(result, durationMs), [result, durationMs]);
  return (
    <div className="tester-report" data-testid="tester-report">
      <Summary r={report} />
      <Quality r={report} />
      <Streaks r={report} />
      <Costs r={report} />
      <Stability r={report} />
      <Criteria r={report} />
    </div>
  );
}

/* ── sections ─────────────────────────────────────────────────────────────── */

function Summary({ r }: { r: BacktestReport }) {
  const s = r.stats;
  return (
    <Section title="Итог" testId="rep-summary">
      <Row k="Чистая прибыль"
           v={`${fmtSigned(s.netProfit)} USDT (${fmtSigned(s.netProfitPct)}%)`}
           mode={s.netProfit >= 0 ? "pos" : "neg"} />
      <Row k="Конечная эквити" v={`${fmtUsdt(s.finalEquity)} USDT`} />
      <Row k="Стартовый баланс" v={`${fmtUsdt(r.run.initialBalance)} USDT`} />
      <Row k="Сделок" v={`${s.trades} (${s.wins}W / ${s.losses}L)`} />
      <Row k="Доля прибыльных" v={`${(s.winRate * 100).toFixed(1)}%`} mode={s.winRate >= 0.5 ? "pos" : undefined} />
      <Row k="Средняя длительность" v={fmtDuration(s.avgHoldSec)} />
      <Row k="Баров в прогоне" v={`${r.run.bars} · ${r.run.from} .. ${r.run.to}`} />
    </Section>
  );
}

function Quality({ r }: { r: BacktestReport }) {
  const s = r.stats;
  const ratio = s.avgLoss !== 0 ? Math.abs(s.avgWin / s.avgLoss) : Infinity;
  return (
    <Section title="Качество" testId="rep-quality">
      <Row k="Профит-фактор" v={Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"} />
      <Row k="Максимальная просадка"
           v={`−${fmtUsdt(s.maxDrawdown)} USDT (−${s.maxDrawdownPct.toFixed(2)}%)`} mode="neg" />
      <Row k="Sharpe, годовой" v={s.sharpeAnnual.toFixed(2)} hint="дневной × √365" />
      <Row k="Sharpe, дневной" v={s.sharpeDaily.toFixed(4)} />
      <Row k="Средняя сделка" v={`${fmtSigned(s.avgTrade)} USDT`} mode={s.avgTrade >= 0 ? "pos" : "neg"} />
      <Row k="Средняя прибыльная" v={`${fmtSigned(s.avgWin)} USDT`} mode="pos" />
      <Row k="Средний убыток" v={`${fmtSigned(s.avgLoss)} USDT`} mode="neg" />
      <Row k="Выигрыш / проигрыш" v={Number.isFinite(ratio) ? ratio.toFixed(2) : "∞"} />
    </Section>
  );
}

function Streaks({ r }: { r: BacktestReport }) {
  const st = r.streaks;
  const max = st.lossDistribution.reduce((m, b) => Math.max(m, b.count), 0);
  return (
    <Section title="Серии" testId="rep-streaks">
      <Row k="Макс. серия убытков" v={String(st.maxLossStreak)} mode={st.maxLossStreak > 5 ? "neg" : undefined} />
      <Row k="Макс. серия прибылей" v={String(st.maxWinStreak)} mode="pos" />
      <Row k="Убыточных серий" v={`${st.lossStreaks}, средняя ${st.avgLossStreak.toFixed(2)}`} />
      {st.lossDistribution.length > 0 ? (
        <div className="streak-hist" data-testid="rep-streak-hist">
          {st.lossDistribution.map((b) => (
            <div className="sh-col" key={b.length} title={`${b.count} серий длиной ${b.length}`}>
              <span className="sh-count">{b.count}</span>
              <span className="sh-bar" style={{ height: Math.max(3, (b.count / (max || 1)) * 52) + "px" }} />
              <span className="sh-len">{b.length}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rep-note">Убыточных серий нет.</div>
      )}
      <div className="rep-note">Ось X — длина серии подряд убыточных сделок, ось Y — сколько раз она случилась.</div>
    </Section>
  );
}

function Costs({ r }: { r: BacktestReport }) {
  const e = r.execution;
  return (
    <Section title="Издержки" testId="rep-costs">
      <Row k="Фандинг" v={`${fmtSigned(e.funding)} USDT`} mode={e.funding >= 0 ? "pos" : "neg"} />
      <Row k="Отклонённых ордеров" v={String(e.rejectedOrders)} mode={e.rejectedOrders > 0 ? "neg" : undefined} />
      <Row k="Ликвидаций" v={String(e.liquidations)} mode={e.liquidations > 0 ? "neg" : undefined} />
      <Row k="Осталось открытых позиций" v={String(e.openPositions)} />
      <Row k="Осталось висящих ордеров" v={String(e.pendingOrders)} />
      <Row k="Модели издержек"
           v={r.costs.applied.length ? r.costs.applied.join(", ") : "без моделей издержек"} />
      <div className="rep-note">
        Комиссии и проскальзывание движок пока не отдаёт отдельными суммами — они уже вычтены
        из P/L каждой сделки, но разложить их построчно нельзя. Список моделей выше — то,
        под чем шёл прогон; без него цифры не сравнимы с другим отчётом.
      </div>
    </Section>
  );
}

function Stability({ r }: { r: BacktestReport }) {
  const w = r.rolling;
  const fmtWin = (x: { fromSec: number; toSec: number; returnPct: number } | null): string => {
    if (!x) return "n/a";
    const d = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
    return `${d(x.fromSec)} .. ${d(x.toSec)} · ${fmtSigned(x.returnPct)}%`;
  };
  return (
    <Section title="Устойчивость" testId="rep-stability">
      {w.insufficient ? (
        <div className="rep-note">
          Прогон короче одного окна ({w.windowDays} дней) — доля прибыльных окон не считается.
          Возьми диапазон побольше, чтобы этот блок ожил.
        </div>
      ) : (
        <>
          <Row k="Прибыльных окон"
               v={`${(w.share * 100).toFixed(1)}% (${w.profitable}/${w.windows})`}
               mode={w.share >= 0.6 ? "pos" : "neg"}
               hint={`окно ${w.windowDays}д, шаг ${w.stepDays}д`} />
          <Row k="Лучшее окно"  v={fmtWin(w.best)}  mode="pos" />
          <Row k="Худшее окно"  v={fmtWin(w.worst)} mode="neg" />
        </>
      )}
      <Row k="Стресс ×2 по издержкам"
           v={r.stress ? r.stress.profitFactor.toFixed(2) : "не запускался"} />
      <div className="rep-note">
        Стресс-прогон из UI пока не запускается — он есть в CLI (`stressSlippage` в RunSpec).
      </div>
    </Section>
  );
}

function Criteria({ r }: { r: BacktestReport }) {
  const v = r.criteria;
  return (
    <Section title="Критерии приёмки" testId="rep-criteria">
      <div className={"verdict " + (v.passed ? "pass" : "fail")} data-testid="rep-verdict">
        {v.passed ? "СТРАТЕГИЯ ПРОШЛА" : "НЕ ПРОШЛА"}
        {!v.passed && v.failed.length > 0 && <span className="dim"> · провалено: {v.failed.join(", ")}</span>}
        {!v.passed && v.unchecked.length > 0 && <span className="dim"> · не проверено: {v.unchecked.join(", ")}</span>}
      </div>
      <table className="criteria-table">
        <thead>
          <tr><th>Критерий</th><th>Порог</th><th>Факт</th><th></th></tr>
        </thead>
        <tbody>
          {v.checks.map((c) => <CriterionRow key={c.key} c={c} />)}
        </tbody>
      </table>
    </Section>
  );
}

function CriterionRow({ c }: { c: CriterionCheck }) {
  const word = c.passed === true ? "PASS" : c.passed === false ? "FAIL" : c.gate ? "SKIP" : "INFO";
  const cls  = c.passed === true ? "pass" : c.passed === false ? "fail" : "skip";
  return (
    <tr className={cls}>
      <td>{c.label}{c.note && <div className="crit-note">{c.note}</div>}</td>
      <td className="dim">{c.requirement}</td>
      <td className="mono">{c.value}</td>
      <td><span className={"crit-badge " + cls}>{word}</span></td>
    </tr>
  );
}

/* ── primitives ───────────────────────────────────────────────────────────── */

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="rep-section" data-testid={testId}>
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function Row({ k, v, mode, hint }: { k: string; v: string; mode?: "pos" | "neg"; hint?: string }) {
  const cls = mode === "pos" ? "pnl-pos" : mode === "neg" ? "pnl-neg" : "";
  return (
    <div className="rep-row">
      <span className="k">{k}{hint && <em>{hint}</em>}</span>
      <span className={"v " + cls}>{v}</span>
    </div>
  );
}
