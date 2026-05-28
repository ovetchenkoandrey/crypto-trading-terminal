import { useState } from "react";
import { useStore } from "../lib/store";
import type { PanelKey, LayoutKey, DrawingTool } from "../lib/store";
import { TIMEFRAMES } from "../lib/symbols";
import { SettingsDialog } from "./SettingsDialog";

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
  const [showSettings, setShowSettings] = useState(false);

  const LAYOUTS: { key: LayoutKey; label: string }[] = [
    { key: "1", label: "1×1" },
    { key: "2", label: "1×2" },
    { key: "4", label: "2×2" },
  ];

  return (
    <div className="toolbar">
      <button className="icon-btn" title="Новый график">📊</button>
      <button className="icon-btn" title="Сохранить">💾</button>
      <span className="sep" />
      <button className="icon-btn active" title="Свечи">🕯</button>
      <button className="icon-btn" title="Линия">📈</button>
      <span className="sep" />

      {TIMEFRAMES.map((tf) => (
        <button
          key={tf.value}
          className={"tf-btn" + (tf.value === timeframe ? " active" : "")}
          onClick={() => setTimeframe(tf.value)}
        >
          {tf.label}
        </button>
      ))}

      <span className="sep" />
      <button
        className="icon-btn"
        title="Прокрутить к текущему моменту"
        onClick={() => window.dispatchEvent(new CustomEvent("trading-app:scroll-to-realtime"))}
      >⏵</button>
      <span className="sep" />
      <button
        className={"icon-btn" + (currentTool === "cursor" ? " active" : "")}
        title="Курсор / выбор (Esc)"
        onClick={() => setCurrentTool("cursor")}
      >✛</button>
      {TOOL_BTNS.map((t) => (
        <button
          key={t.tool}
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
        title={theme === "dark" ? "Переключить на светлую (Ctrl+J)" : "Переключить на тёмную (Ctrl+J)"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? "🌙" : "☀️"}
      </button>

      <div className="layout-switcher">
        {LAYOUTS.map((l) => (
          <button
            key={l.key}
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
            className={"icon-btn " + (panels[p.key] ? "on" : "off")}
            title={p.title}
            onClick={() => togglePanel(p.key)}
          >
            {p.icon}
          </button>
        ))}
      </div>

      <button className="btn" onClick={() => setShowSettings(true)}>⚙ Настройки</button>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  );
}
