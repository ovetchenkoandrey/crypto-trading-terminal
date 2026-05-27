import type { PanelKey, PanelsState, LayoutKey } from "./MainWindow";

interface ToolbarProps {
  panels: PanelsState;
  togglePanel: (k: PanelKey) => void;
  timeframe: string;
  setTimeframe: (tf: string) => void;
  layout: LayoutKey;
  setLayout: (l: LayoutKey) => void;
}

const TFS: { value: string; label: string }[] = [
  { value: "1",   label: "M1" },
  { value: "5",   label: "M5" },
  { value: "15",  label: "M15" },
  { value: "60",  label: "H1" },
  { value: "240", label: "H4" },
  { value: "D",   label: "D1" },
  { value: "W",   label: "W1" },
];

const PANEL_BTNS: { key: PanelKey; icon: string; title: string }[] = [
  { key: "marketWatch", icon: "👁", title: "Обзор рынка (Ctrl+M)" },
  { key: "orderBook",   icon: "📊", title: "Стакан / DOM (Ctrl+D)" },
  { key: "navigator",   icon: "🤖", title: "Навигатор (Ctrl+N)" },
  { key: "terminal",    icon: "📋", title: "Терминал (Ctrl+T)" },
];

export function Toolbar({ panels, togglePanel, timeframe, setTimeframe, layout, setLayout }: ToolbarProps) {
  return (
    <div className="toolbar">
      <button className="icon-btn" title="Новый график">📊</button>
      <button className="icon-btn" title="Сохранить">💾</button>
      <span className="sep" />
      <button className="icon-btn active" title="Свечи">🕯</button>
      <button className="icon-btn" title="Линия">📈</button>
      <span className="sep" />

      {TFS.map((tf) => (
        <button
          key={tf.value}
          className={"tf-btn" + (tf.value === timeframe ? " active" : "")}
          onClick={() => setTimeframe(tf.value)}
        >
          {tf.label}
        </button>
      ))}

      <span className="sep" />
      <button className="icon-btn" title="Индикатор">𝑓</button>
      <button className="icon-btn" title="Линия тренда">📐</button>
      <button className="icon-btn" title="Горизонтальная линия">─</button>
      <button className="icon-btn" title="Фибоначчи">𝝓</button>
      <button className="icon-btn" title="Текст">T</button>
      <span className="sep" />
      <button className="icon-btn active" title="Крестик">✛</button>
      <button className="icon-btn" title="Авто-скролл">⏵</button>

      <span className="spacer" />

      <div className="layout-switcher">
        <button className={layout === "1" ? "active" : ""} onClick={() => setLayout("1")}>1×1</button>
        <button className={layout === "2" ? "active" : ""} onClick={() => setLayout("2")}>1×2</button>
        <button className={layout === "4" ? "active" : ""} onClick={() => setLayout("4")}>2×2</button>
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

      <button className="btn">⚙ Настройки</button>
    </div>
  );
}
