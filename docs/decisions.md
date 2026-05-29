# Architectural decisions

Короткий лог. Свежее — внизу.

### 1. Zustand вместо Redux/MobX
**Context:** На E1A нужен был общий store для marketData / ui / paper / bots, чтобы
не таскать props через MainWindow.
**Decision:** Zustand.
**Why:** Лёгкий (~3KB), без boilerplate, встроенный `persist` middleware с partialize,
TypeScript-дружественный. Redux под наш размер — overkill.

### 2. ExecutionVenue абстракция
**Context:** До этого боты и потенциальный ручной ввод дёргали `paperEngine` напрямую.
При появлении demo/live/backtest пришлось бы менять все вызовы.
**Decision:** Интерфейс `ExecutionVenue` + `VenueRouter` (singleton). Все участники
ходят через `venue` из `router.ts`.
**Why:** Подмена paper → demo → live → backtest без правок в ботах и UI. Единая точка
для логирования, троттлинга, прав. Stub-venues для нереализованных режимов сразу есть.

### 3. lightweight-charts v5
**Context:** Нужен быстрый канвасный чарт с поддержкой свечей, линий, гистограмм,
priceLines и маркеров.
**Decision:** lightweight-charts v5.
**Why:** Нативный canvas-рендеринг (не лагает на 1000+ баров), API priceLine и
markers есть из коробки. Trade-off: интерактивные drawings (hline/trendline/fib)
пришлось делать SVG-overlay'ем поверх — у LWC нет click API для primitives.

### 4. Maker-семантика клика по цене
**Context:** Сначала клик в стакан и клик в чарт работали по-разному. Пользователь
запутался.
**Decision:** Везде одинаково. Клик ВЫШЕ mid (по чарту) или по ask-строке (в стакане) =
Sell Limit; клик НИЖЕ или по bid-строке = Buy Limit. Side определяется позицией клика,
а не направлением рынка.
**Why:** Поведение совпадает с реальной maker-логикой: ставишь лимитку туда, где её
исполнит контрагент. Унификация была отдельным fix-коммитом после фидбэка.

### 5. Slippage только для market и stop
**Context:** Делая slippage-модели, надо было решить, применять ли их к лимиткам.
**Decision:** Limit и postOnly — slippage = 0.
**Why:** Limit-ордер — это maker-сторона, ты не платишь спред. Slippage появляется
только когда сам берёшь ликвидность (market) или стоп-маркет триггерится.

### 6. Свечи как UTC-секунды
**Context:** Bybit REST/WS отдаёт миллисекунды, lightweight-charts ждёт секунды.
**Decision:** На границе парсера делим на 1000. Внутри приложения свечной `time` —
всегда UTC-секунды, число.
**Why:** Требование LWC. Любая попытка передать миллисекунды ломает оси и markers.
Инвариант проще держать на входе, чем разбираться по всему коду.

### 7. Deep-merge settings при rehydrate
**Context:** После добавления поля в `Settings` старые persisted-снапшоты затирали
новое поле дефолтом `undefined`, что роняло UI (см. коммит `aa9a29e`).
**Decision:** При rehydrate сливать persisted snapshot с дефолтами рекурсивно через
mergeDeep, а не shallow-replace.
**Why:** Дёшево, защищает от регрессий при каждом расширении формы Settings. Цена —
помнить, что глубокий merge может склеить и нежелательные коллекции; пока не мешает.

### 8. Опасные шорткаты — opt-in
**Context:** Shift+click для market-ордера и B/S quick-buttons могут случайно
открыть позицию без подтверждения.
**Decision:** По умолчанию выключены. Включаются явно в Settings → Trading. Когда
включены — горит бейдж в Status Bar.
**Why:** Дефолт безопасен. Если кто-то включил — видит постоянное напоминание, что
в этом режиме клики опасны.

### 9. Defensive defaults в applySlippage
**Context:** Старые persist-снапшоты могли не иметь `slippage` в settings — функция
падала с `Cannot read properties of undefined`.
**Decision:** Если `cfg` undefined — вернуть refPrice без slippage и без ошибки.
**Why:** Юзер не должен наблюдать crash из-за миграции формата. Утилиты в hot-path
исполнения обязаны быть толерантными к частично заполненному стейту.

### 10. Один Order Popup, управляемый через store
**Context:** Popup открывается из стакана, из чарта, по F9, из тулбара. Делать
несколько копий — путь к рассинхрону.
**Decision:** Один инстанс `OrderPopup` в `MainWindow`, состояние (открыт/закрыт,
anchor, prefilled side/price) — в slice `orderPopup` стора.
**Why:** Любой источник просто диспатчит `openOrderPopup({...})`, popup сам решает,
куда якориться. Закрытие — один путь.

### 11. Fill markers — последние 100 на символ
**Context:** Бот за сутки может оставить тысячи маркеров на чарте. LWC начинает
тормозить, и визуально это шум.
**Decision:** TradingOverlay держит rolling-окно последних 100 fill-маркеров на символ.
**Why:** Свежие сделки видно, чарт остаётся отзывчивым. История полная — в терминале
во вкладке История и через export-csv. Если понадобится — поднимем лимит.
