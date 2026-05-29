import { useState } from "react";
import { Modal } from "./Modal";
import { useStore } from "../lib/store";
import type { Settings, FontScale, ChartType, HistoryDepth, PnlMode, HistoryProvider, SlippageKind } from "../lib/settings";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { TIMEFRAMES } from "../lib/symbols";

type TabKey =
  | "appearance" | "chart" | "indicators" | "drawings"
  | "paper" | "notifications" | "network" | "historyDb" | "shortcuts" | "about";

interface TabDef { key: TabKey; icon: string; label: string }

const TABS: TabDef[] = [
  { key: "appearance",    icon: "🎨", label: "Внешний вид" },
  { key: "chart",         icon: "📊", label: "График" },
  { key: "indicators",    icon: "𝑓",  label: "Индикаторы" },
  { key: "drawings",      icon: "📐", label: "Рисование" },
  { key: "paper",         icon: "💼", label: "Paper trading" },
  { key: "notifications", icon: "🔔", label: "Уведомления" },
  { key: "network",       icon: "🌐", label: "Сеть" },
  { key: "historyDb",     icon: "🗄", label: "Историческая БД" },
  { key: "shortcuts",     icon: "⌨",  label: "Горячие клавиши" },
  { key: "about",         icon: "ℹ", label: "О программе" },
];

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const currentSettings = useStore((s) => s.settings);
  const updateSettings  = useStore((s) => s.updateSettings);
  const resetSettings   = useStore((s) => s.resetSettings);
  const theme           = useStore((s) => s.theme);
  const setTheme        = useStore((s) => s.setTheme);

  const [tab, setTab] = useState<TabKey>("appearance");
  const [draft, setDraft] = useState<Settings>(currentSettings);

  const dirty = JSON.stringify(draft) !== JSON.stringify(currentSettings);

  const apply = () => { updateSettings(draft); onClose(); };
  const reset = () => {
    if (window.confirm("Сбросить все настройки к значениям по умолчанию?")) {
      resetSettings();
      onClose();
    }
  };

  return (
    <Modal title="⚙ Настройки" onClose={onClose} width={920}>
      <div className="settings-body">

        <div className="settings-tabs">
          {TABS.map((t) => (
            <div key={t.key}
                 className={"settings-tab" + (tab === t.key ? " active" : "")}
                 onClick={() => setTab(t.key)}>
              <span className="ico">{t.icon}</span>{t.label}
            </div>
          ))}
        </div>

        <div className="settings-content">
          {tab === "appearance"    && <AppearanceTab    draft={draft} setDraft={setDraft} theme={theme} setTheme={setTheme} />}
          {tab === "chart"         && <ChartTab         draft={draft} setDraft={setDraft} />}
          {tab === "indicators"    && <IndicatorsTab    draft={draft} setDraft={setDraft} />}
          {tab === "drawings"      && <DrawingsTab      draft={draft} setDraft={setDraft} />}
          {tab === "paper"         && <PaperTab         draft={draft} setDraft={setDraft} />}
          {tab === "notifications" && <NotificationsTab draft={draft} setDraft={setDraft} />}
          {tab === "network"       && <NetworkTab       draft={draft} setDraft={setDraft} />}
          {tab === "historyDb"     && <HistoryDbTab     draft={draft} setDraft={setDraft} />}
          {tab === "shortcuts"     && <ShortcutsTab />}
          {tab === "about"         && <AboutTab />}
        </div>

      </div>

      <div className="settings-foot">
        <button className="btn danger" onClick={reset}>Сбросить всё</button>
        <div className="spacer" />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!dirty} onClick={apply}>
          {dirty ? "Применить" : "Без изменений"}
        </button>
      </div>
    </Modal>
  );
}

// ─── shared field helpers ─────────────────────────────

interface FieldProps { label: string; hint?: string; children: React.ReactNode }
function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">
        <span className="lbl">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-section">
      <h2>{title}</h2>
      {hint && <div className="settings-sub" style={{ marginTop: -4, marginBottom: 8 }}>{hint}</div>}
      {children}
    </div>
  );
}

interface SegProps<T extends string> { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }
function Seg<T extends string>({ value, options, onChange }: SegProps<T>) {
  return (
    <div className="settings-seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <div className={"settings-toggle" + (value ? " on" : "")} onClick={() => onChange(!value)} />;
}

interface ColorProps { value: string; onChange: (v: string) => void }
function ColorPicker({ value, onChange }: ColorProps) {
  return (
    <div className="color-with-hex">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <code>{value}</code>
    </div>
  );
}

type DraftSetter = (s: Settings | ((prev: Settings) => Settings)) => void;
interface DraftProps { draft: Settings; setDraft: DraftSetter }

// ─── tabs ─────────────────────────────

function AppearanceTab({ draft, setDraft, theme, setTheme }:
  DraftProps & { theme: "dark"|"light"; setTheme: (t: "dark"|"light") => void }) {
  const a = draft.appearance;
  const upd = (patch: Partial<typeof a>) => setDraft((d) => ({ ...d, appearance: { ...d.appearance, ...patch } }));
  return (
    <>
      <h1 className="settings-h1">Внешний вид</h1>
      <p className="settings-sub">Тема, цвета, шрифты</p>

      <Section title="Тема">
        <Field label="Цветовая схема" hint="Также Ctrl+J на клавиатуре">
          <Seg value={theme}
               options={[{value: "dark", label: "🌙 Тёмная"}, {value: "light", label: "☀️ Светлая"}]}
               onChange={(v) => setTheme(v)} />
        </Field>
        <Field label="Акцентный цвет" hint="Активные кнопки, выделение, рамка ячейки">
          <ColorPicker value={a.accentColor} onChange={(v) => upd({ accentColor: v })} />
        </Field>
      </Section>

      <Section title="Цвета свечей">
        <Field label="Растущая (bull)">
          <ColorPicker value={a.candleUpColor} onChange={(v) => upd({ candleUpColor: v })} />
        </Field>
        <Field label="Падающая (bear)">
          <ColorPicker value={a.candleDownColor} onChange={(v) => upd({ candleDownColor: v })} />
        </Field>
        <Field label="Предустановка">
          <div className="settings-seg">
            <button onClick={() => upd({ candleUpColor: "#26a69a", candleDownColor: "#ef5350" })}>TradingView</button>
            <button onClick={() => upd({ candleUpColor: "#0ecb81", candleDownColor: "#f6465d" })}>Биржевая</button>
            <button onClick={() => upd({ candleUpColor: "#00ff00", candleDownColor: "#ff3030" })}>MT4-классика</button>
          </div>
        </Field>
      </Section>

      <Section title="Шрифт">
        <Field label="Масштаб интерфейса">
          <Seg<FontScale> value={a.fontScale}
                          options={[{value: "sm", label: "Мелкий"}, {value: "md", label: "Средний"}, {value: "lg", label: "Крупный"}]}
                          onChange={(v) => upd({ fontScale: v })} />
        </Field>
      </Section>
    </>
  );
}

function ChartTab({ draft, setDraft }: DraftProps) {
  const c = draft.chart;
  const upd = (patch: Partial<typeof c>) => setDraft((d) => ({ ...d, chart: { ...d.chart, ...patch } }));
  return (
    <>
      <h1 className="settings-h1">График</h1>
      <p className="settings-sub">Параметры графика по умолчанию</p>

      <Section title="Тип и история">
        <Field label="Тип графика по умолчанию">
          <Seg<ChartType> value={c.defaultChartType}
                          options={[{value: "candle", label: "🕯 Свечи"}, {value: "line", label: "📈 Линия"}, {value: "area", label: "▰ Область"}]}
                          onChange={(v) => upd({ defaultChartType: v })} />
        </Field>
        <Field label="ТФ по умолчанию">
          <select value={c.defaultTimeframe} onChange={(e) => upd({ defaultTimeframe: e.target.value })}>
            {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Глубина истории" hint="Сколько свечей грузим при открытии">
          <Seg<string> value={String(c.historyDepth)}
                       options={[{value: "200", label: "200"}, {value: "500", label: "500"}, {value: "1000", label: "1000"}]}
                       onChange={(v) => upd({ historyDepth: parseInt(v, 10) as HistoryDepth })} />
        </Field>
      </Section>

      <Section title="Отображение">
        <Field label="Показывать объём">
          <Toggle value={c.showVolume} onChange={(v) => upd({ showVolume: v })} />
        </Field>
        <Field label="Показывать сетку">
          <Toggle value={c.showGrid} onChange={(v) => upd({ showGrid: v })} />
        </Field>
        <Field label="Отступ справа" hint="Пустых баров после последней свечи">
          <input type="number" min={0} max={50} value={c.rightOffset}
                 onChange={(e) => upd({ rightOffset: parseInt(e.target.value, 10) || 0 })} />
        </Field>
      </Section>
    </>
  );
}

function IndicatorsTab({ draft, setDraft }: DraftProps) {
  const ind = draft.indicators;
  const upd = <K extends keyof typeof ind>(key: K, patch: Partial<typeof ind[K]>) =>
    setDraft((d) => ({ ...d, indicators: { ...d.indicators, [key]: { ...d.indicators[key], ...patch } } }));
  return (
    <>
      <h1 className="settings-h1">Индикаторы</h1>
      <p className="settings-sub">Параметры по умолчанию при добавлении на график</p>

      <Section title="SMA — Moving Average">
        <Field label="Период"><input type="number" min={1} value={ind.sma.period} onChange={(e) => upd("sma", { period: +e.target.value })} /></Field>
        <Field label="Цвет"><ColorPicker value={ind.sma.color} onChange={(v) => upd("sma", { color: v })} /></Field>
      </Section>

      <Section title="EMA">
        <Field label="Период"><input type="number" min={1} value={ind.ema.period} onChange={(e) => upd("ema", { period: +e.target.value })} /></Field>
        <Field label="Цвет"><ColorPicker value={ind.ema.color} onChange={(v) => upd("ema", { color: v })} /></Field>
      </Section>

      <Section title="RSI">
        <Field label="Период"><input type="number" min={1} value={ind.rsi.period} onChange={(e) => upd("rsi", { period: +e.target.value })} /></Field>
        <Field label="Цвет"><ColorPicker value={ind.rsi.color} onChange={(v) => upd("rsi", { color: v })} /></Field>
      </Section>

      <Section title="MACD">
        <Field label="Быстрый период"><input type="number" min={1} value={ind.macd.fast} onChange={(e) => upd("macd", { fast: +e.target.value })} /></Field>
        <Field label="Медленный период"><input type="number" min={1} value={ind.macd.slow} onChange={(e) => upd("macd", { slow: +e.target.value })} /></Field>
        <Field label="Сигнальный период"><input type="number" min={1} value={ind.macd.signal} onChange={(e) => upd("macd", { signal: +e.target.value })} /></Field>
        <Field label="Цвет"><ColorPicker value={ind.macd.color} onChange={(v) => upd("macd", { color: v })} /></Field>
      </Section>

      <Section title="Bollinger Bands">
        <Field label="Период"><input type="number" min={1} value={ind.bollinger.period} onChange={(e) => upd("bollinger", { period: +e.target.value })} /></Field>
        <Field label="Отклонение (σ)"><input type="number" min={0.1} step={0.1} value={ind.bollinger.stdDev} onChange={(e) => upd("bollinger", { stdDev: +e.target.value })} /></Field>
        <Field label="Цвет"><ColorPicker value={ind.bollinger.color} onChange={(v) => upd("bollinger", { color: v })} /></Field>
      </Section>
    </>
  );
}

function DrawingsTab({ draft, setDraft }: DraftProps) {
  const d = draft.drawings;
  const upd = (patch: Partial<typeof d>) => setDraft((s) => ({ ...s, drawings: { ...s.drawings, ...patch } }));
  return (
    <>
      <h1 className="settings-h1">Рисование</h1>
      <p className="settings-sub">Линии тренда, горизонтали, фибо, текст</p>

      <Section title="По умолчанию">
        <Field label="Цвет"><ColorPicker value={d.defaultColor} onChange={(v) => upd({ defaultColor: v })} /></Field>
        <Field label="Толщина линии">
          <select value={d.defaultLineWidth} onChange={(e) => upd({ defaultLineWidth: +e.target.value as 1|2|3|4 })}>
            {[1,2,3,4].map((w) => <option key={w} value={w}>{w}px</option>)}
          </select>
        </Field>
      </Section>

      <Section title="Привязка (snap)">
        <Field label="Прилипать к свечам и OHLC">
          <Toggle value={d.snapEnabled} onChange={(v) => upd({ snapEnabled: v })} />
        </Field>
        <Field label="Порог привязки" hint="Пикселей до OHLC чтобы магнитить">
          <input type="number" min={1} max={50} value={d.snapThresholdPx}
                 onChange={(e) => upd({ snapThresholdPx: +e.target.value || 10 })} />
        </Field>
      </Section>

      <Section title="Перекрестие">
        <Field label="Отключать магнит crosshair'а когда выделена линия"
               hint="Удобно при редактировании — крест не магнитится к OHLC и не мешает выбирать линию">
          <Toggle value={d.disableMagnetOnSelection} onChange={(v) => upd({ disableMagnetOnSelection: v })} />
        </Field>
      </Section>
    </>
  );
}

function PaperTab({ draft, setDraft }: DraftProps) {
  // Defensive: if the user is on a persisted store snapshot from before slippage
  // existed, the deep-merge in store.ts will fill it in — but if anything else
  // strips it (e.g. layout import from an old JSON), we still don't crash.
  const slip = draft.paperTrading.slippage ?? DEFAULT_SETTINGS.paperTrading.slippage;
  const p = { ...draft.paperTrading, slippage: slip };
  const upd = (patch: Partial<typeof p>) => setDraft((s) => ({ ...s, paperTrading: { ...s.paperTrading, ...patch } }));
  const resetAccount = useStore((s) => s.resetPaperAccount);
  return (
    <>
      <h1 className="settings-h1">Paper trading</h1>
      <p className="settings-sub">Виртуальная торговля без реальных ордеров</p>

      <Section title="Параметры">
        <Field label="Стартовый баланс" hint="USDT, при сбросе аккаунта">
          <input type="number" min={1} value={p.initialBalance}
                 onChange={(e) => upd({ initialBalance: +e.target.value || 0 })} />
        </Field>
        <Field label="Комиссия" hint="Доля от сделки (0.001 = 0.1%)">
          <input type="number" min={0} step={0.0001} value={p.feeRate}
                 onChange={(e) => upd({ feeRate: +e.target.value || 0 })} />
        </Field>
        <Field label="Показывать P&L">
          <Seg<PnlMode> value={p.pnlMode}
                        options={[{value: "abs", label: "В USDT"}, {value: "pct", label: "В процентах"}]}
                        onChange={(v) => upd({ pnlMode: v })} />
        </Field>
      </Section>

      <Section title="Проскальзывание" hint="Применяется к market-ордерам и stop-ордерам после триггера. Limit-ордера исполняются ровно по своей цене.">
        <Field label="Модель">
          <Seg<SlippageKind> value={p.slippage.kind}
                             options={[
                               { value: "none",          label: "Off" },
                               { value: "fixed_bps",     label: "Fixed bps" },
                               { value: "spread_pct",    label: "% спреда" },
                               { value: "volume_impact", label: "Volume impact" },
                             ]}
                             onChange={(v) => upd({ slippage: { ...p.slippage, kind: v } })} />
        </Field>
        {p.slippage.kind === "fixed_bps" && (
          <Field label="Slippage, bps" hint="1 bps = 0.01%. Типично 1–5 bps для ликвидных пар.">
            <input type="number" min={0} step={0.1} value={p.slippage.bps}
                   onChange={(e) => upd({ slippage: { ...p.slippage, bps: +e.target.value || 0 } })} />
          </Field>
        )}
        {p.slippage.kind === "spread_pct" && (
          <Field label="Доля спреда (0..1)" hint="0.5 = половина текущего bid-ask спреда">
            <input type="number" min={0} max={1} step={0.05} value={p.slippage.spreadPct}
                   onChange={(e) => upd({ slippage: { ...p.slippage, spreadPct: +e.target.value || 0 } })} />
          </Field>
        )}
        {p.slippage.kind === "volume_impact" && (
          <>
            <Field label="Коэффициент k, bps" hint="impact = k · sqrt(qty / refQty), в базисных пунктах">
              <input type="number" min={0} step={0.1} value={p.slippage.impactK}
                     onChange={(e) => upd({ slippage: { ...p.slippage, impactK: +e.target.value || 0 } })} />
            </Field>
            <Field label="Reference qty" hint="Объём, для которого impact = k bps">
              <input type="number" min={0} step={0.1} value={p.slippage.impactRefQty}
                     onChange={(e) => upd({ slippage: { ...p.slippage, impactRefQty: +e.target.value || 0 } })} />
            </Field>
          </>
        )}
      </Section>

      <Section title="Опасная зона">
        <div className="settings-danger-zone">
          <h3>Сбросить аккаунт</h3>
          <div className="text">Удалит все позиции, открытые ордера и историю сделок. Баланс вернётся к стартовому ({p.initialBalance} USDT).</div>
          <button className="btn danger" onClick={() => {
            if (window.confirm("Сбросить paper-trading аккаунт?")) resetAccount();
          }}>Сбросить</button>
        </div>
      </Section>
    </>
  );
}

function NotificationsTab({ draft, setDraft }: DraftProps) {
  const n = draft.notifications;
  const upd = (patch: Partial<typeof n>) => setDraft((s) => ({ ...s, notifications: { ...s.notifications, ...patch } }));
  return (
    <>
      <h1 className="settings-h1">Уведомления</h1>
      <p className="settings-sub">Звук и системные уведомления</p>

      <Section title="Звук">
        <Field label="Проигрывать звук на алерты"><Toggle value={n.alertSound}   onChange={(v) => upd({ alertSound: v })} /></Field>
      </Section>

      <Section title="Системные">
        <Field label="Native push" hint="Уведомление Windows"><Toggle value={n.nativePush}   onChange={(v) => upd({ nativePush: v })} /></Field>
        <Field label="На закрытие сделки"><Toggle value={n.onCloseTrade} onChange={(v) => upd({ onCloseTrade: v })} /></Field>
        <Field label="На действие бота"><Toggle  value={n.onBotOrder}   onChange={(v) => upd({ onBotOrder: v })} /></Field>
      </Section>
    </>
  );
}

function NetworkTab({ draft, setDraft }: DraftProps) {
  const n = draft.network;
  const upd = (patch: Partial<typeof n>) => setDraft((s) => ({ ...s, network: { ...s.network, ...patch } }));
  return (
    <>
      <h1 className="settings-h1">Сеть</h1>
      <p className="settings-sub">Подключение к Bybit</p>

      <Section title="Backend">
        <Field label="Среда" hint="Mainnet — реальные данные, Testnet — тестовая среда">
          <Seg value={n.backend}
               options={[{value: "mainnet", label: "Mainnet"}, {value: "testnet", label: "Testnet"}]}
               onChange={(v) => upd({ backend: v })} />
        </Field>
        <Field label="WS reconnect (мс)">
          <input type="number" min={500} max={60000} step={500} value={n.wsReconnectMs}
                 onChange={(e) => upd({ wsReconnectMs: +e.target.value || 3000 })} />
        </Field>
        <Field label="REST timeout (мс)">
          <input type="number" min={1000} max={60000} step={500} value={n.restTimeoutMs}
                 onChange={(e) => upd({ restTimeoutMs: +e.target.value || 10000 })} />
        </Field>
      </Section>
    </>
  );
}

function HistoryDbTab({ draft, setDraft }: DraftProps) {
  const h = draft.historyDb;
  const upd = (patch: Partial<typeof h>) => setDraft((s) => ({ ...s, historyDb: { ...s.historyDb, ...patch } }));
  return (
    <>
      <h1 className="settings-h1">Историческая БД</h1>
      <p className="settings-sub">Хранение свечей для бэктестов (фаза 2 — UI готов, движок впереди)</p>

      <div className="settings-info">
        <strong>⏳ Подготовка к бэктестам.</strong> Сами бэктесты пока не запускаются — кэш свечей и провайдеры подключим следующим этапом. UI сохраняет настройки.
      </div>

      <Section title="Источник истории">
        <Field label="Провайдер" hint="Архитектура заложена для нескольких источников">
          <Seg<HistoryProvider> value={h.provider}
                                options={[
                                  {value: "bybit",   label: "Bybit REST"},
                                  {value: "binance", label: "Binance archive"},
                                  {value: "file",   label: "Локальные CSV"},
                                ]}
                                onChange={(v) => upd({ provider: v })} />
        </Field>
        <Field label="Глубина истории">
          <Seg<string> value={String(h.depthYears)}
                       options={[
                         {value: "0.5", label: "6 мес"},
                         {value: "1",   label: "1 год"},
                         {value: "2",   label: "2 года"},
                         {value: "5",   label: "5 лет"},
                         {value: "0",   label: "Максимум"},
                       ]}
                       onChange={(v) => upd({ depthYears: parseFloat(v) })} />
        </Field>
      </Section>

      <Section title="Хранилище (IndexedDB)">
        <Field label="Размер кэша (МБ, soft cap)">
          <input type="number" min={50} max={5000} step={50} value={h.maxCacheMb}
                 onChange={(e) => upd({ maxCacheMb: +e.target.value || 500 })} />
        </Field>
        <Field label="Фоновая докачка" hint="Догружать историю когда приложение бездействует">
          <Toggle value={h.backgroundBackfill} onChange={(v) => upd({ backgroundBackfill: v })} />
        </Field>
        <Field label="Загруженные данные" hint="Будет показано после подключения engine">
          <span style={{ color: "var(--fg-mute)" }}>—</span>
        </Field>
      </Section>
    </>
  );
}

function ShortcutsTab() {
  const rows: [string, string][] = [
    ["Ctrl + D", "Toggle Стакан"],
    ["Ctrl + N", "Toggle Навигатор"],
    ["Ctrl + T", "Toggle Терминал"],
    ["Ctrl + J", "Переключить тему"],
    ["Esc",      "Отменить рисование / снять выделение"],
    ["Delete",   "Удалить выделенный объект"],
  ];
  return (
    <>
      <h1 className="settings-h1">Горячие клавиши</h1>
      <p className="settings-sub">Текущие комбинации</p>

      <table className="settings-shortcuts">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td><kbd>{k}</kbd></td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AboutTab() {
  return (
    <>
      <h1 className="settings-h1">О программе</h1>
      <p className="settings-sub">Crypto Trading Terminal</p>
      <Section title="Версия">
        <Field label="Сборка"><span>0.3.0 — drawings + settings</span></Field>
      </Section>
      <Section title="Стек">
        <Field label="Frontend"><span>Electron 32 + React 18 + TypeScript + Vite</span></Field>
        <Field label="Графики"><span>TradingView Lightweight Charts v5</span></Field>
        <Field label="State"><span>Zustand + persist</span></Field>
        <Field label="Биржа"><span>Bybit V5 (Spot + Linear)</span></Field>
      </Section>
    </>
  );
}
