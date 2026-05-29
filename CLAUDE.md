# Trading app — заметки для Claude

Electron + Vite + React 18 + Zustand терминал крипто-трейдинга (Bybit, lightweight-charts).
Большая часть логики живёт в `src/` как обычное веб-приложение; Electron — тонкая обёртка
(`electron/main.ts`, `electron/preload.ts`).

## Как тестировать изменения

Три слоя — выбирай по тому, что правил.

### 1. Чистые функции — Vitest (`npm test`)

Индикаторы, исполнение, расчёты комиссий/slippage, утилиты форматирования и т.п.
Файлы рядом с исходником: `foo.ts` → `foo.test.ts`.

Покрытие на сегодня:
- `src/lib/indicators/{sma,ema,rsi,atr,stochastic}.test.ts`
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

## Стек / соглашения

- TypeScript strict, ESM.
- Состояние: Zustand, persist через `partialize` (см. `src/lib/store.ts`, `src/lib/settings.ts`).
  При изменении формы `Settings` помни про deep-merge при rehydrate (коммит `aa9a29e`).
- Свечи: `time` в **UTC-секундах**, совместимо с lightweight-charts.
- Исполнение: абстракция `ExecutionVenue` + `VenueRouter` (`src/lib/execution/`).
  Реальные ордера на Bybit — отдельная веха, пока только Paper.
- Стиль кода: без избыточных комментариев, без эмодзи. Имя файла-теста = имя исходника + `.test.ts`.
