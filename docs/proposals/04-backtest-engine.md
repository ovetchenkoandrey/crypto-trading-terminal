# Этап 4 — Backtest engine

Связанный мокап: `design/backtest-tester-mockup.html` (согласован).

## Что делаем

Прогон бот-стратегии по сохранённой истории Bybit с целью оценить эффективность до запуска на live/paper. Тот же `MatchingEngine` что paper — slippage и fee одинаковые. Изолированный set positions/orders/history.

## Архитектура

```
src/lib/history/
  cache.ts          — IndexedDB кеш свечей по ключу {symbol, interval}
  bybitHistory.ts   — REST загрузка с Bybit kline (pagination, 1000 баров за запрос)

src/lib/execution/backtest/
  clock.ts          — BacktestClock: "сейчас" = индекс свечи. Управление скоростью.
  BacktestVenue.ts  — реализация ExecutionVenue. Источник цены — текущая свеча.
  runner.ts         — Setup → bot.start → tick loop → bot.stop → stats. Эмиттит progress events.
  stats.ts          — расчёт метрик: netProfit, winRate, maxDrawdown, profitFactor, avgTrade, avgHold, sharpe

src/components/tester/
  Tester.tsx        — таб в Терминале
  TesterForm.tsx    — форма настроек
  TesterRunning.tsx — progress + live equity (визуальный) / stats (фоновый)
  TesterResults.tsx — финальный отчёт + trades table
```

Store-slice `backtest`: `{ state: "idle"|"running"|"done", params, progress, result }`.

## Согласованные решения

- **Точки входа**: основная — таб «Тестер» в Терминале. Дополнительная — кнопка «📊 Backtest» в `BotConfigDialog` (заполняет форму этим config'ом).
- **Два режима**:
  - **Визуальный** — главный чарт переходит в `BACKTEST` (синий бейдж), проигрывает свечи + рисует маркеры. WS-обновления для этого символа во время прогона игнорируются.
  - **Фоновый** — главный чарт остаётся LIVE, прогон в стороне, только прогресс и финал.
- **Изоляция**: BacktestVenue ведёт свой набор positions/orders/history. Не пишет в paper-слайсы. Можно гонять backtest пока paper параллельно работает.
- **Скорость (визуальный)**: ступени 1× / 10× / 50× / Max (Max = без таймера, шаг = next tick).
- **Диапазон**: пресет 7 / 30 / 90 / 365 дней либо custom from/to. Если нет в кеше — подкачка из Bybit REST, прогресс показывается.
- **Метрики**: Net profit (USDT + %), Trades (W/L), Win rate, Profit factor, Max drawdown (USDT + %), Avg trade, Avg hold time, Sharpe ratio (дневной).
- **Команды плеера**: Pause / Step / Stop / Speed.
- **Save report**: JSON-файл с params + stats + trades. Открывается через Layout-import позже (или просто хранится у пользователя).

## Что не делаем сейчас (отложено)

- Optimization (параметрический поиск)
- Multi-symbol backtests
- Walk-forward / Monte Carlo
- Backtest ручной торговли (только боты)
- TP/SL триггерные ордера в backtest (зависит от matching engine, который ещё не поддерживает их в paper)

## Порядок работ

1. **4A — Backend.** HistoryCache (IndexedDB), Bybit REST loader, BacktestClock, BacktestVenue, runner, stats. Unit-тесты на stats и matching.
2. **4B — UI фоновый.** Таб Tester в Terminal, форма, фоновый прогон, отчёт. Этого хватает для первого реального использования.
3. **4C — Визуальный режим.** ChartPane получает `playbackMode` — отключает WS для символа, рисует свечи из BacktestClock, маркеры через тот же TradingOverlay.
4. **4D — Доп точка входа из BotConfigDialog.**

## Инварианты

- `BacktestVenue.placeOrder` использует тот же путь slippage + fee что paper — иначе backtest показывает не то.
- IndexedDB кеш версионируется (на случай изменения схемы свечей).
- Свечи в кеше — UTC секунды, совпадает с lightweight-charts.
- Runner НЕ блокирует UI — прогон через `requestAnimationFrame` (визуальный) или `setTimeout(0)` чанками (фоновый).
