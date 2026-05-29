// Glues the tester UI (TesterFormParams in tester store) to the actual runner
// and history loader. Handles range resolution, fetch, run, cancellation.

import { useStore } from "../store";
import type { Interval } from "../types";
import { ensureRange } from "../history/bybitHistory";
import { runBacktest } from "../execution/backtest/runner";
import { useTesterStore, type TesterFormParams } from "./store";
import { logInfo, logWarn, logOk } from "../eventBus";

function rangeBounds(form: TesterFormParams): { from: number; to: number } {
  const now = Math.floor(Date.now() / 1000);
  switch (form.rangePreset) {
    case "7d":   return { from: now - 7   * 86400, to: now };
    case "30d":  return { from: now - 30  * 86400, to: now };
    case "90d":  return { from: now - 90  * 86400, to: now };
    case "365d": return { from: now - 365 * 86400, to: now };
    case "custom": return { from: form.fromSec, to: form.toSec };
  }
}

/**
 * Kick off a backtest from current tester-store params. Updates tester-store
 * as it progresses. Safe to call multiple times — earlier runs are abandoned
 * via the `cancelRequested` flag (each run captures its own snapshot of that).
 */
export async function startBacktestFromForm(form: TesterFormParams): Promise<void> {
  const ts = useTesterStore.getState();

  // Resolve bot config
  const cfg = useStore.getState().botConfigs.find((b) => b.id === form.botId);
  if (!cfg) {
    ts.fail(`Бот ${form.botId} не найден в Навигаторе`);
    return;
  }

  const { from, to } = rangeBounds(form);
  if (to <= from) {
    ts.fail("Неверный диапазон: до ≤ от");
    return;
  }

  ts.beginLoading();
  logInfo("backtest", `прогон ${cfg.kind} · ${form.symbol} · ${form.interval} · ${new Date(from * 1000).toISOString().slice(0, 10)}..${new Date(to * 1000).toISOString().slice(0, 10)}`);

  // 1. Load history (with cache miss = network fetch)
  let candles;
  try {
    candles = await ensureRange(form.symbol, form.interval as Interval, from, to, (p) => {
      useTesterStore.getState().setLoadProgress(p.loaded, p.estimated);
    });
  } catch (err) {
    useTesterStore.getState().fail(`Не удалось загрузить историю: ${String(err)}`);
    logWarn("backtest", `history load failed: ${String(err)}`);
    return;
  }
  if (candles.length === 0) {
    useTesterStore.getState().fail("В диапазоне нет свечей");
    return;
  }

  // 2. Run
  useTesterStore.getState().beginRun();
  const settings = useStore.getState().settings.paperTrading;
  try {
    const result = await runBacktest({
      symbol:        form.symbol,
      candles,
      bot:           cfg,
      initialBalance: form.initialBalance,
      feeRate:       settings.feeRate,
      slippageCfg:   settings.slippage,
    }, {
      onProgress: (p) => useTesterStore.getState().setRunProgress(p),
      shouldStop: () => useTesterStore.getState().cancelRequested,
      // background mode = no yield. Visual mode would await a paced delay here.
      onBarComplete: form.mode === "visual" ? makeYielder(form.speed) : undefined,
    });
    if (useTesterStore.getState().cancelRequested) {
      logWarn("backtest", "прогон отменён");
    } else {
      logOk("backtest", `завершено: ${result.stats.trades} сделок, P/L ${result.stats.netProfit.toFixed(2)} USDT`);
    }
    useTesterStore.getState().finish(result);
  } catch (err) {
    useTesterStore.getState().fail(`Ошибка прогона: ${String(err)}`);
    logWarn("backtest", `run failed: ${String(err)}`);
  }
}

/**
 * Build an onBarComplete callback that yields long enough to give the chart a
 * chance to repaint. Speed × means 1 visual second = N candles.
 * speed=0 (Max) → no delay, just a microtask yield to keep UI responsive.
 */
function makeYielder(speed: number) {
  if (speed === 0) {
    return () => new Promise<void>((r) => setTimeout(r, 0));
  }
  // 1× = 1 bar per second (effectively). 50× = 50 bars per second → 20ms each.
  const perBarMs = Math.max(0, 1000 / speed);
  return () => new Promise<void>((r) => setTimeout(r, perBarMs));
}
