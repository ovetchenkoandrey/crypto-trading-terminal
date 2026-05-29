# Trading app — заметки для Claude

Electron + Vite + React 18 + Zustand терминал крипто-трейдинга (Bybit, lightweight-charts).
Большая часть логики живёт в `src/` как обычное веб-приложение; Electron — тонкая обёртка
(`electron/main.ts`, `electron/preload.ts`).

## TL;DR что делает программа

MetaTrader-подобный десктоп-терминал для крипты на Bybit. Живые данные (spot + linear)
по WebSocket, чарт на lightweight-charts с индикаторами и инструментами рисования,
кликабельный стакан, ручное открытие позиций через Order Popup (F9 / клик в стакан /
клик в чарт), оверлей открытых позиций и pending-ордеров поверх свечей, paper-trading
с реалистичным slippage, два бота (Grid, DCA) на paper, тулбар + меню + терминал с
табами Позиции / Ордера / История / Алерты / Журнал, Settings dialog на 10 вкладок.
Реальный Bybit live mainnet — пока заглушка, всё трейдинговое крутится через PaperVenue.

## Архитектурная схема

```
Electron (electron/main.ts, preload.ts)         тонкая обёртка, окно, безопасный IPC
        │
        ▼
React UI (src/components/*)                     ChartPane, OrderBook, Terminal,
        │                                       Toolbar, MenuBar, OrderPopup, Settings…
        ▼
Zustand store (src/lib/store.ts, settings.ts)   marketData, ui, paper, bots,
        │                                       orderPopup, settings + persist
        ▼
ExecutionVenue (src/lib/execution/*)            единая абстракция; VenueRouter
        │                                       прокидывает на active venue
   ┌────┴──────────┬────────┬──────────┐
   ▼               ▼        ▼          ▼
PaperVenue      DemoVenue  LiveVenue  BacktestVenue
(работает)      (stub)     (stub)     (stub)
   │
   ▼
Bybit WS/REST (src/lib/bybitWs.ts, bybit.ts, instruments.ts)
```

`ExecutionVenue.placeOrder` — единственная точка отправки ордера. Боты, OrderPopup,
шорткаты — все идут через `venue` из `router.ts`. Никто не дёргает `paperEngine` напрямую.

## Карта файлов

Где что лежит — если правишь что-то слева, лезь в файлы справа.

| Область | Файлы |
|---|---|
| Чарт, свечи, priceLines, fill markers (TradingOverlay) | `src/components/ChartPane.tsx` |
| Мозаика 1/2/4 ячейки | `src/components/ChartMosaic.tsx` |
| Индикаторы (SMA/EMA/RSI/MACD/Bollinger/Stochastic/ATR/Fractals) | `src/lib/indicators/*` + `registry.ts` |
| Picker / params dialog индикаторов | `src/components/IndicatorPicker.tsx`, `IndicatorParamsDialog.tsx` |
| Drawings (hline/trendline/fib/text) | `src/components/SvgDrawingOverlay.tsx`, `src/lib/drawings/*` |
| Стакан (кликабельный) | `src/components/OrderBook.tsx` |
| Order Popup, training toast | `src/components/order/OrderPopup.tsx`, `order/TrainingToast.tsx` |
| Zustand store + типы | `src/lib/store.ts` |
| Settings: типы и дефолты | `src/lib/settings.ts` |
| Settings UI (10 табов) | `src/components/SettingsDialog.tsx` |
| ExecutionVenue + Router | `src/lib/execution/router.ts`, `types.ts`, `PaperVenue.ts` |
| Slippage модели | `src/lib/execution/slippage.ts` |
| Paper matching engine | `src/lib/paper/engine.ts` |
| Боты: Grid, DCA, базовый класс, manager | `src/lib/bots/*` |
| Bot config UI | `src/components/bots/BotConfigDialog.tsx` |
| Терминал (Позиции/Ордера/История/Алерты/Журнал) | `src/components/Terminal.tsx` |
| Тулбар, меню | `src/components/Toolbar.tsx`, `MenuBar.tsx` |
| Статус-бар | `src/components/StatusBar.tsx` |
| Symbol picker, navigator | `src/components/SymbolPicker.tsx`, `Navigator.tsx` |
| Bybit WebSocket клиент | `src/lib/bybitWs.ts` |
| Bybit REST instruments | `src/lib/instruments.ts`, `bybit.ts`, `symbols.ts` |
| Event bus (лог, бот-события) | `src/lib/eventBus.ts` |
| Layout import/export | `src/lib/layoutIO.ts` |
| Скрипты (close-all, export-csv…) | `src/lib/scripts.ts` |
| Главный layout | `src/App.tsx`, `src/components/MainWindow.tsx` |
| Electron обёртка | `electron/main.ts`, `electron/preload.ts` |
| Стили (один большой файл) | `src/styles/global.css` |
| Дизайн-мокапы | `design/*.html` |
| Проектная документация | `ROADMAP.md`, `docs/decisions.md` |

## Текущее состояние venue'ов

| Venue | Состояние | Где |
|---|---|---|
| `paper` | Работает полноценно. Лимиты/маркеты/стопы, slippage по моделям из settings, fee, fills, P&L. | `src/lib/execution/PaperVenue.ts`, `src/lib/paper/engine.ts` |
| `demo` | Stub — `throw "venue:demo not implemented"`. | `src/lib/execution/router.ts` |
| `live` | Stub — то же самое. | `src/lib/execution/router.ts` |
| `backtest` | Stub — то же самое. | `src/lib/execution/router.ts` |

Реальные реализации демо/лайв/бектеста подменяются через `venue.register(mode, impl)`.

## Инварианты которые нельзя нарушать

- **Единая точка отправки ордера** — `venue.placeOrder()` из `src/lib/execution/router.ts`.
  Боты, OrderPopup, шорткаты — всё через router. Никто не дёргает `paperEngine.place*` напрямую.
- **Свечи: `time` в UTC-секундах**, не миллисекундах. Этого требует lightweight-charts.
  Все REST/WS-парсеры должны давать секунды.
- **Persist + новые поля Settings** — при добавлении поля в `Settings` проверь, что
  `mergeDeep` в `store.ts` его подберёт при rehydrate (коммит `aa9a29e`). Иначе старый
  снапшот выкинет новые значения на дефолтных юзерах.
- **Bybit live mainnet — никогда автоматически.** Только руками пользователя. Любая
  trading-логика тестируется на `PaperVenue` с синтетическими свечами.
- **Стиль кода** — без эмодзи в файлах, без избыточных комментариев. Имя файла-теста
  = имя исходника + `.test.ts`, лежит рядом.
- **Тесты** — vitest, файлы рядом с исходниками. `npm test` — должно быть зелено.
- **Не запускать `npm run dev` для UI-проверок** — он поднимет Electron окно. Используй
  `preview_start name="vite"` (или вручную `npm run dev:vite`) и кликай через
  `data-testid`.
- **Defensive defaults** — в утилитах вроде `applySlippage` cfg может быть `undefined`
  (старый persist-снапшот). Падать нельзя — возвращать refPrice без slippage.

## Как тестировать изменения

Три слоя — выбирай по тому, что правил.

### 1. Чистые функции — Vitest (`npm test`)

Индикаторы, исполнение, расчёты комиссий/slippage, утилиты форматирования и т.п.
Файлы рядом с исходником: `foo.ts` → `foo.test.ts`.

Покрытие на сегодня:
- `src/lib/indicators/{sma,ema,rsi,atr,stochastic,fractals}.test.ts`
- `src/lib/execution/slippage.test.ts`

Если правишь что-то из `src/lib/indicators/`, `src/lib/execution/`, `src/lib/paper/`,
`src/lib/bots/` — **сначала допиши/обнови тест, потом гоняй `npm test`.**
Без UI это занимает <1с и ловит регрессии раньше любого preview.

### 2. UI / React-компоненты — Claude Preview

Vite dev-сервер на `http://localhost:5173`. Поднимать через `preview_start name="vite"`
(см. [`.claude/launch.json`](.claude/launch.json)),
проверять через `preview_click` / `preview_fill` / `preview_snapshot`.
Скриншот делать в самом конце для пруфа пользователю.

Сценарии: открытие диалогов, выбор символа/таймфрейма, добавление индикаторов и рисований,
работа бот-конфигов, сохранение/загрузка layout, persist в `localStorage` через `preview_eval`.

**Не запускать `npm run dev`** (он поднимает ещё и Electron окно).
Только `npm run dev:vite` — голый Vite, который умеет preview.

#### data-testid конвенция

Стабильные селекторы вешать через `data-testid`, не через текст или классы.
Уже размечено (см. компоненты `Toolbar`, `MenuBar`, `Modal`, `SettingsDialog`):

- Toolbar: `tf-{value}` (M1/M5… — value из `TIMEFRAMES`), `layout-{1|2|4}`,
  `chart-type-{candle|line|area}`, `tool-{cursor|trendline|hline|fib|text}`,
  `theme-toggle`, `open-indicator-picker`, `open-settings`,
  `toggle-panel-{orderBook|navigator|terminal}`, `layout-import`, `layout-export`.
- MenuBar: `menu-{file|view|insert|charts|service|window|help}` + dropdown:
  `menu-{id}-dropdown`.
- Modal (через prop `testId`): корневая карточка получает `data-testid={testId}`,
  крестик — `{testId}-close`, фон — `{testId}-backdrop`.
- SettingsDialog: модал — `settings-modal`, табы — `settings-tab-{key}`,
  кнопки внизу — `settings-reset` / `settings-cancel` / `settings-apply`.

Если правишь новый UI-компонент, который надо будет тестировать — вешай `data-testid`
по тому же стилю (kebab-case, говорящее имя, без префикса `data-`).

### 3. Electron-специфика — пока вручную

Если правишь `electron/main.ts`, `electron/preload.ts`, IPC, нативное меню, packaging —
автоматически не проверяется. Скажи об этом прямо в ответе и попроси прогнать руками
через `npm run dev` или `npm run package`.

При необходимости можно добавить Playwright с `_electron.launch()` — но до тех пор,
пока меняется в основном React-слой, это оверкилл.

### 4. Bybit live API — никогда автоматически

Реальный mainnet — только руками пользователя. Любая trading-логика проверяется через
`PaperVenue` (`src/lib/execution/PaperVenue.ts`) на синтетических свечах.

## Cheat sheet для новой сессии (TL;DR)

Если открываешь новый чат и нужно быстро ввести Claude в курс — этого хватит:

```
- Стек: Electron + Vite + React + Zustand + Bybit + lightweight-charts.
- Чистые функции (indicators / execution / paper / bots): пиши тесты рядом
  как `foo.test.ts`, прогоняй `npm test`.
- UI: правишь компонент → `preview_start name="vite"` → клик/snapshot через
  `data-testid` (список в CLAUDE.md ниже) → скриншот пользователю.
- Electron-обёртка (electron/main.ts, preload.ts): автотестов нет, проси прогнать
  `npm run dev` руками.
- Bybit live mainnet: НИКОГДА автоматически. Только PaperVenue на синтетике.
- Не запускай `npm run dev` для UI-проверок — он поднимет Electron окно поверх.
  Используй `npm run dev:vite` или `preview_start name="vite"`.
- Все ордера — через `venue.placeOrder` из `src/lib/execution/router.ts`.
  Никто не дёргает paperEngine напрямую.
```

## Стек / соглашения

- TypeScript strict, ESM.
- Состояние: Zustand, persist через `partialize` (см. `src/lib/store.ts`, `src/lib/settings.ts`).
  При изменении формы `Settings` помни про deep-merge при rehydrate (коммит `aa9a29e`).
- Свечи: `time` в **UTC-секундах**, совместимо с lightweight-charts.
- Исполнение: абстракция `ExecutionVenue` + `VenueRouter` (`src/lib/execution/`).
  Реальные ордера на Bybit — отдельная веха, пока только Paper.
- Стиль кода: без избыточных комментариев, без эмодзи. Имя файла-теста = имя исходника + `.test.ts`.
