// A mosaic cell running in BACKTEST mode.
//
// It replaces the live chart in one cell: the same ChartPane, fed with the run's
// own candles, plus the trades layer, the player and the equity strip. Every
// other cell, the order book and the navigator stay live — that is the whole
// point of the MT4-classic layout picked in design/backtest-visual-v2.html.
//
// The player replays a *recorded* run rather than pacing a live one. Recorded
// playback is scrubbable, repeatable and instant to restart, and it keeps the
// engine out of the render loop.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTesterStore, type TesterSpeed } from "../../lib/backtest/store";
import { ChartPane, type ChartHandles } from "../ChartPane";
import { BacktestEquityStrip } from "./BacktestEquityStrip";
import {
  autoDisplayTf, barSecOf, buildDisplayCandles, buildTradeViews, buildUnfilledViews,
  displayTfOptions, tfLabelSec,
} from "./model";
import { fmtUsdt } from "../../lib/format";

const SPEEDS: TesterSpeed[] = [1, 10, 50, 0];

export function BacktestChartCell() {
  const result   = useTesterStore((s) => s.run.result);
  const view     = useTesterStore((s) => s.view);
  const hideChart = useTesterStore((s) => s.hideChart);
  const [handles, setHandles] = useState<ChartHandles | null>(null);
  const handlesRef = useRef<ChartHandles | null>(null);
  handlesRef.current = handles;

  const source   = result?.params.candles ?? [];
  const nativeSec = useMemo(() => barSecOf(source), [source]);
  const tfSec = view.displayTfSec ?? autoDisplayTf(nativeSec, source.length);

  const displayCandles = useMemo(
    () => buildDisplayCandles(source, tfSec, nativeSec),
    [source, tfSec, nativeSec],
  );

  const allTrades = useMemo(
    () => buildTradeViews(result?.trades ?? [], displayCandles),
    [result, displayCandles],
  );
  const unfilled = useMemo(
    () => buildUnfilledViews(result?.orders ?? [], displayCandles),
    [result, displayCandles],
  );

  const replay = view.replay;
  const total  = displayCandles.length;
  const cursor = replay.active ? Math.min(replay.bar, Math.max(0, total - 1)) : total - 1;
  const cursorTime = total > 0 ? displayCandles[Math.max(0, cursor)].time : 0;

  const shownCandles = useMemo(
    () => (replay.active ? displayCandles.slice(0, cursor + 1) : displayCandles),
    [replay.active, displayCandles, cursor],
  );
  const shownTrades = useMemo(
    () => (replay.active ? allTrades.filter((t) => t.exitBarTime <= cursorTime) : allTrades),
    [replay.active, allTrades, cursorTime],
  );
  const shownEquity = useMemo(() => {
    const eq = result?.equity ?? [];
    return replay.active ? eq.filter((e) => e.time <= cursorTime) : eq;
  }, [result, replay.active, cursorTime]);

  // Player tick. Speeds mean bars per second; Max walks a fixed slice of the run
  // per frame so a long run does not take an hour to watch.
  useEffect(() => {
    if (!replay.playing || total <= 1) return;
    const perTick   = replay.speed === 0 ? Math.max(1, Math.round(total / 500)) : 1;
    const intervalMs = replay.speed === 0 ? 16 : Math.max(16, 1000 / replay.speed);
    const id = window.setInterval(() => {
      const st = useTesterStore.getState();
      const next = st.view.replay.bar + perTick;
      if (next >= total - 1) {
        st.replaySetBar(total - 1);
        st.replaySetPlaying(false);
      } else {
        st.replaySetBar(next);
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [replay.playing, replay.speed, total]);

  // Keep the newest replayed bar on screen.
  useEffect(() => {
    if (!replay.active || !replay.playing) return;
    try { handlesRef.current?.chart.timeScale().scrollToPosition(0, false); } catch { /* chart gone */ }
  }, [replay.active, replay.playing, cursor]);

  // Focus request from the trades table: centre the chart on that trade.
  useEffect(() => {
    if (view.focusNonce === 0) return;
    const h = handlesRef.current;
    const trade = allTrades.find((t) => t.id === view.selectedTradeId);
    if (!h || !trade) return;
    // A trade past the replay cursor cannot be shown — end the replay first.
    const st = useTesterStore.getState();
    if (st.view.replay.active && trade.exitBarTime > cursorTime) {
      st.replaySetActive(false);
    }
    const span = Math.max(trade.exitBarTime - trade.entryBarTime, tfSec * 10);
    const pad  = Math.max(span * 0.6, tfSec * 15);
    const from = Math.max(displayCandles[0]?.time ?? 0, trade.entryBarTime - pad);
    const to   = Math.min(displayCandles[displayCandles.length - 1]?.time ?? 0, trade.exitBarTime + pad);
    if (!(to > from)) return;
    // setTimeout rather than rAF: a chart in a background tab never gets a
    // frame, and the jump would silently never happen.
    window.setTimeout(() => {
      try {
        h.chart.timeScale().setVisibleRange({ from: from as never, to: to as never });
      } catch { /* range outside data */ }
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.focusNonce]);

  if (!result) return null;

  const st = useTesterStore.getState();
  const pct = total > 1 ? ((cursor + 1) / total) * 100 : 100;
  const equityNow = shownEquity.length ? shownEquity[shownEquity.length - 1].equity : result.params.initialBalance;
  const tfOptions = displayTfOptions(nativeSec);

  return (
    <div className="chart-cell bt-cell active" data-testid="bt-cell">
      <div className="chart-cell-head bt-head">
        <span className="pill backtest" data-testid="bt-badge">● BACKTEST</span>
        <span className="sym">{result.params.symbol}</span>
        <span className="tf">{tfLabelSec(tfSec)}</span>
        <span className="bt-date">{cursorTime ? new Date(cursorTime * 1000).toISOString().slice(0, 16).replace("T", " ") : "—"}</span>
        <span className="bt-count">{shownTrades.length} сделок</span>
        <span className={"bt-eq " + (equityNow >= result.params.initialBalance ? "pnl-pos" : "pnl-neg")}>
          {fmtUsdt(equityNow)}
        </span>

        <span className="spacer" />

        <span className="bt-tf-picker">
          {tfOptions.map((o) => (
            <button key={o.sec}
                    data-testid={`bt-tf-${o.sec}`}
                    className={o.sec === tfSec ? "active" : ""}
                    title={o.sec === nativeSec ? "Исполнительный таймфрейм" : "Агрегированный вид"}
                    onClick={() => st.setDisplayTf(o.sec === nativeSec ? nativeSec : o.sec)}>
              {o.label}
            </button>
          ))}
        </span>

        <button className="bt-x" data-testid="bt-close" title="Вернуть живой график" onClick={hideChart}>✕</button>
      </div>

      <div className="chart-host bt-host">
        <ChartPane
          data={shownCandles}
          symbol={result.params.symbol}
          timeframe={tfLabelSec(tfSec)}
          chartType="candle"
          backtest={{
            trades: shownTrades,
            unfilled,
            selectedId: view.selectedTradeId,
            showSegments: view.layers.segments,
            showMarkers: view.layers.markers,
            showRejected: view.layers.rejected,
            onSelectTrade: (id) => st.selectTrade(id, { reveal: true }),
          }}
          fitOnLoad={!replay.active}
          onChartReady={setHandles}
          onCrosshairTime={(sec) => useTesterStore.getState().setHoverTime(sec)}
        />
      </div>

      {view.layers.equity && (
        <BacktestEquityStrip
          priceChart={handles?.chart ?? null}
          priceSeries={handles?.series ?? null}
          equity={shownEquity}
          initialBalance={result.params.initialBalance}
          hoverTimeSec={view.hoverTimeSec}
          onHoverTime={(sec) => useTesterStore.getState().setHoverTime(sec)}
        />
      )}

      <div className="bt-player" data-testid="bt-player">
        <button data-testid="bt-play"
                className={replay.playing ? "on" : ""}
                title={replay.playing ? "Пауза" : "Воспроизвести"}
                onClick={() => {
                  const s = useTesterStore.getState();
                  if (s.view.replay.playing) { s.replaySetPlaying(false); return; }
                  if (!s.view.replay.active) s.replaySetActive(true);
                  s.replaySetPlaying(true);
                }}>
          {replay.playing ? "⏸" : "▶"}
        </button>
        <button data-testid="bt-step" title="Шаг вперёд на бар"
                onClick={() => {
                  const s = useTesterStore.getState();
                  if (!s.view.replay.active) s.replaySetActive(true);
                  s.replaySetPlaying(false);
                  s.replaySetBar(Math.min(total - 1, (s.view.replay.active ? s.view.replay.bar : 0) + 1));
                }}>⏭</button>
        <button data-testid="bt-stop" title="Стоп — показать весь прогон"
                onClick={() => useTesterStore.getState().replaySetActive(false)}>⏹</button>

        <div className="bt-pbar" data-testid="bt-progress"
             onClick={(e) => {
               const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
               const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
               const s = useTesterStore.getState();
               s.replaySetActive(true);
               s.replaySetPlaying(false);
               s.replaySetBar(Math.round(ratio * (total - 1)));
             }}>
          <div style={{ width: pct + "%" }} />
        </div>
        <span className="bt-pct">{pct.toFixed(0)}%</span>

        <span className="bt-speeds">
          {SPEEDS.map((sp) => (
            <button key={sp}
                    data-testid={`bt-speed-${sp}`}
                    className={replay.speed === sp ? "active" : ""}
                    onClick={() => useTesterStore.getState().replaySetSpeed(sp)}>
              {sp === 0 ? "Max" : `${sp}×`}
            </button>
          ))}
        </span>

        <span className="bt-layers">
          <Layer k="segments" label="Отрезки" />
          <Layer k="markers"  label="Маркеры" />
          <Layer k="rejected" label="Неисполненные" />
          <Layer k="equity"   label="Эквити" />
        </span>
      </div>
    </div>
  );
}

function Layer({ k, label }: { k: "segments" | "markers" | "rejected" | "equity"; label: string }) {
  const on = useTesterStore((s) => s.view.layers[k]);
  const toggle = useTesterStore((s) => s.toggleLayer);
  return (
    <label className="bt-layer" data-testid={`bt-layer-${k}`}>
      <input type="checkbox" checked={on} onChange={() => toggle(k)} />
      {label}
    </label>
  );
}
