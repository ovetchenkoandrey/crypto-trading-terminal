# Roadmap

## Сделано

- **Этап 0: Scaffold.** Electron + Vite + React + TS, production-сборка через electron-packager.
  MT-layout, 4 dock-панели, тулбар, статус-бар, мозаика 1/2/4.
- **Этап 0.3–0.4: Базовый чарт.** lightweight-charts v5, REST-загрузка 200 свечей BTCUSDT.
- **Этап 1A: Real-time data layer.** Zustand store, Bybit WebSocket, живые тикеры / OB /
  свечи, журнал в терминале.
- **Этап 1B: UX-полировка.** Меню (Файл/Вид/…), диалоги Settings/About, SymbolPicker,
  мозаика с разными символами, dark/light тема, persist в localStorage.
- **Этап 1C: Индикаторы.** SMA / EMA / RSI / MACD / Bollinger, drag-n-drop из навигатора,
  отдельные pane'ы для осцилляторов.
- **Этап 1D: Paper-trading + Grid Bot.** Виртуальные ордера исполняются на живых ценах Bybit.
- **Чарт-полировка.** Wheel=zoom, drag=scroll, fitContent при первой загрузке,
  rightOffset, отключение axis-drag zoom. Загрузка 1000 баров, показ последних 200.
- **Drawing tools.** Hline / trendline / fib / text. SVG-overlay поверх канваса,
  drag-to-create, edit handles, snap к OHLC, dblclick → params dialog.
- **MagnetOHLC crosshair.** Snap к ближайшему O/H/L/C рядом со свечой.
- **Settings tabbed dialog.** 10 секций, persisted slice, appearance CSS variables live.
- **Дополнительные индикаторы.** Stochastic, ATR, Bill Williams Fractals.
- **Indicator picker popup, layout export/import.**
- **Scripts.** close-all, export-csv. Magnet toggle на selection. DCA bot.
- **Этап 2: ExecutionVenue абстракция.** PaperVenue + VenueRouter, демо/лайв/бектест —
  заглушки. Боты и UI идут только через router.
- **Slippage модели** — `fixed_bps` / `spread_pct` / `volume_impact`, fee из settings.
- **Persist hardening.** Deep-merge settings при rehydrate, defensive slippage default.
- **Тесты.** Vitest setup, юнит-тесты индикаторов и slippage, data-testid конвенция.
- **Этап 2.5: Ручное открытие позиций.** Anchored Order Popup, F9, кликабельный
  стакан (maker-side по позиции строки), dangerous shortcuts (Shift+click market,
  B/S quick) с явным opt-in в settings + бейдж в Status Bar.
- **Click-to-trade на чарт.** Клик по пустому месту чарта открывает Order Popup
  с auto-side (выше mid = Sell Limit, ниже = Buy Limit). Унификация семантики
  со стаканом.
- **Этап 3: TradingOverlay.** PriceLines открытых позиций / pending ордеров на чарте,
  fill маркеры на свечах (последние 100 на символ), training toast, threshold confirm
  для крупных market-сумм.

## В работе

(пусто)

## В плане

- **Этап 4: BacktestVenue + BacktestClock.** Прогон стратегий по исторической ленте,
  фейковое время, ускоренное воспроизведение, отчёт по сделкам и P&L.
- **Этап 5: BybitDemoVenue (testnet).** Реальный REST/WS testnet, ключи через
  `safeStorage`, IPC-прослойка из renderer в main для приватных запросов.
- **Этап 6: BybitLiveVenue (mainnet).** Боевая интеграция, красные плашки везде,
  явное подтверждение каждой опасной операции.

## Backlog (отложено сознательно)

- Draggable handles на priceLines (modify limit-цены мышкой на чарте).
- Hover-кнопки close / cancel прямо на линиях позиций и pending-ордеров.
- TP/SL триггерные ордера — нужен расширенный matching engine в PaperVenue.
- Undo-toast для market-ордеров средних сумм.
- Playwright + `_electron.launch()` для Electron-specific автотестов.
- Расширенный backtest report (equity curve, drawdown, Sharpe).
