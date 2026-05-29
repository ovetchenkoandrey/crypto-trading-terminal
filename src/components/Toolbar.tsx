import { useState } from "react";
import { useStore } from "../lib/store";
import type { PanelKey, LayoutKey, DrawingTool } from "../lib/store";
import { TIMEFRAMES } from "../lib/symbols";
import { SettingsDialog } from "./SettingsDialog";
import { IndicatorPicker } from "./IndicatorPicker";
import { INDICATORS } from "../lib/indicators/registry";
import { exportLayout, importLayoutFromFile } from "../lib/layoutIO";

const PANEL_BTNS: { key: PanelKey; icon: string; title: string }[] = [
  { key: "orderBook", icon: "📊", title: "Стакан / DOM (Ctrl+D)" },
  { key: "navigator", icon: "🤖", title: "Навигатор (Ctrl+N)" },
  { key: "terminal",  icon: "📋", title: "Терминал (Ctrl+T)" },
];

const TOOL_BTNS: { tool: DrawingTool; icon: string; title: string }[] = [
  { tool: "trendline", icon: "📐", title: "Линия тренда (клик-клик)" },
  { tool: "hline",     icon: "─", title: "Горизонтальная линия" },
  { tool: "fib",       icon: "𝝓", title: "Фибоначчи (клик-клик)" },
  { tool: "text",      icon: "T", title: "Текст" },
];

export function Toolbar() {
  const panels       = useStore((s) => s.panels);
  const togglePanel  = useStore((s) => s.togglePanel);
  const timeframe    = useStore((s) => s.timeframe);
  const setTimeframe = useStore((s) => s.setTimeframe);
  const layout       = useStore((s) => s.layout);
  const setLayout    = useStore((s) => s.setLayout);
  const theme        = useStore((s) => s.theme);
  const setTheme     = useStore((s) => s.setTheme);
  const currentTool    = useStore((s) => s.currentTool);
  const setCurrentTool = useStore((s) => s.setCurrentTool);
  const activeIndex    = useStore((s) => s.activeCellIndex);
  const activeSymbol   = useStore((s) => s.activeSymbol);
  const activeChartType = useStore((s) => s.mosaicCells[s.activeCellIndex]?.chartType ?? s.settings.chart.defaultChartType);
  const setMosaicCell  = useStore((s) => s.setMosaicCell);
  const addIndicator   = useStore((s) => s.addIndicator);
  const openOrderPopup = useStore((s) => s.openOrderPopup);
  const lastUsedQty    = useStore((s) => s.lastUsedQty);
  const [showSettings, setShowSettings] = useState(false);
  const [showIndicatorPicker, setShowIndicatorPicker] = useState(false);

  const LAYOUTS: { key: LayoutKey; label: string }[] = [
    { key: "1", label: "1×1" },
    { key: "2", label: "1×2" },
    { key: "4", label: "2×2" },
  ];

  return (
    <div className="toolbar">
      <button className="icon-btn" data-testid="layout-import" title="Импорт раскладки из JSON" onClick={() => importLayoutFromFile()}>📂</button>
      <button className="icon-btn" data-testid="layout-export" title="Экспорт раскладки в JSON" onClick={() => exportLayout()}>💾</button>
      <span className="sep" />
      <button className={"icon-btn" + (activeChartType === "candle" ? " active" : "")}
              data-testid="chart-type-candle"
              title="Свечи (для активной ячейки)"
              onClick={() => setMosaicCell(activeIndex, { chartType: "candle" })}>🕯</button>
      <button className={"icon-btn" + (activeChartType === "line" ? " active" : "")}
              data-testid="chart-type-line"
              title="Линия (для активной ячейки)"
              onClick={() => setMosaicCell(activeIndex, { chartType: "line" })}>📈</button>
      <button className={"icon-btn" + (activeChartType === "area" ? " active" : "")}
              data-testid="chart-type-area"
              title="Область (для активной ячейки)"
              onClick={() => setMosaicCell(activeIndex, { chartType: "area" })}>▰</button>
      <span className="sep" />

      {TIMEFRAMES.map((tf) => (
        <button
          key={tf.value}
          data-testid={`tf-${tf.value}`}
          className={"tf-btn" + (tf.value === timeframe ? " active" : "")}
          onClick={() => setTimeframe(tf.value)}
        >
          {tf.label}
        </button>
      ))}

      <span className="sep" />
      <div style={{ position: "relative", display: "inline-block" }}>
        <button
          className={"icon-btn" + (showIndicatorPicker ? " active" : "")}
          data-testid="open-indicator-picker"
          title="Добавить индикатор на активную ячейку"
          onClick={() => setShowIndicatorPicker((v) => !v)}
        >𝑓</button>
        {showIndicatorPicker && (
          <IndicatorPicker
            onPick={(kind) => {
              const def = INDICATORS[kind];
              addIndicator(activeIndex, {
                id: crypto.randomUUID(),
                kind,
                params: { ...def.defaultParams },
                color: def.defaultColor,
              });
            }}
            onClose={() => setShowIndicatorPicker(false)}
          />
        )}
      </div>
      <button
        className="icon-btn"
        data-testid="scroll-to-realtime"
        title="Прокрутить к текущему моменту"
        onClick={() => window.dispatchEvent(new CustomEvent("trading-app:scroll-to-realtime"))}
      >⏵</button>
      <span className="sep" />
      <button
        className="btn btn-order"
        data-testid="open-order-popup"
        title="Новый ордер (F9)"
        onClick={() => openOrderPopup({
          symbol: activeSymbol,
          type: "market",
          qty: lastUsedQty > 0 ? lastUsedQty : undefined,
        }, null)}
      >📝 Новый ордер</button>
      <span className="sep" />
      <button
        className={"icon-btn" + (currentTool === "cursor" ? " active" : "")}
        data-testid="tool-cursor"
        title="Курсор / выбор (Esc)"
        onClick={() => setCurrentTool("cursor")}
      >✛</button>
      {TOOL_BTNS.map((t) => (
        <button
          key={t.tool}
          data-testid={`tool-${t.tool}`}
          className={"icon-btn" + (currentTool === t.tool ? " active" : "")}
          title={t.title}
          onClick={() => setCurrentTool(currentTool === t.tool ? "cursor" : t.tool)}
        >
          {t.icon}
        </button>
      ))}

      <span className="spacer" />

      <button
        className="icon-btn"
        data-testid="theme-toggle"
        title={theme === "dark" ? "Переключить на светлую (Ctrl+J)" : "Переключить на тёмную (Ctrl+J)"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? "🌙" : "☀️"}
      </button>

      <div className="layout-switcher">
        {LAYOUTS.map((l) => (
          <button
            key={l.key}
            data-testid={`layout-${l.key}`}
            className={layout === l.key ? "active" : ""}
            onClick={() => setLayout(l.key)}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="panel-toggles">
        {PANEL_BTNS.map((p) => (
          <button
            key={p.key}
            data-testid={`toggle-panel-${p.key}`}
            className={"icon-btn " + (panels[p.key] ? "on" : "off")}
            title={p.title}
            onClick={() => togglePanel(p.key)}
          >
            {p.icon}
          </button>
        ))}
      </div>

      <button className="btn" data-testid="open-settings" onClick={() => setShowSettings(true)}>⚙ Настройки</button>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  );
}
