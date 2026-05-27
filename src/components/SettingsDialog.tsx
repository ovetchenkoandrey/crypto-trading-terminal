import { useState } from "react";
import { Modal } from "./Modal";
import { useStore } from "../lib/store";
import type { Theme } from "../lib/store";
import { DEFAULT_SYMBOLS, TIMEFRAMES } from "../lib/symbols";

type FontScale = "small" | "medium" | "large";

const FONT_SCALE_MAP: Record<FontScale, string> = {
  small: "0.9",
  medium: "1",
  large: "1.15",
};

interface Props {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: Props) {
  const theme        = useStore((s) => s.theme);
  const setTheme     = useStore((s) => s.setTheme);
  const activeSymbol = useStore((s) => s.activeSymbol);
  const setActiveSymbol = useStore((s) => s.setActiveSymbol);
  const timeframe    = useStore((s) => s.timeframe);
  const setTimeframe = useStore((s) => s.setTimeframe);
  const paperBalance = useStore((s) => s.paperBalance);
  const resetPaperAccount = useStore((s) => s.resetPaperAccount);

  const [fontScale, setFontScale] = useState<FontScale>(() => {
    const v = document.documentElement.style.getPropertyValue("--font-scale");
    if (v === "0.9") return "small";
    if (v === "1.15") return "large";
    return "medium";
  });

  const applyFontScale = (s: FontScale) => {
    setFontScale(s);
    document.documentElement.style.setProperty("--font-scale", FONT_SCALE_MAP[s]);
  };

  const handleReset = () => {
    if (window.confirm("Сбросить бумажный аккаунт? Все позиции и история будут удалены.")) {
      resetPaperAccount();
    }
  };

  return (
    <Modal title="Настройки" onClose={onClose} width={500}>
      <div className="settings-content">

        <div className="settings-section">
          <div className="settings-section-title">Внешний вид</div>
          <div className="settings-row">
            <span className="settings-label">Тема</span>
            <div className="settings-control">
              {(["dark", "light"] as Theme[]).map((t) => (
                <button
                  key={t}
                  className={"btn" + (theme === t ? " active-btn" : "")}
                  onClick={() => setTheme(t)}
                >
                  {t === "dark" ? "🌙 Тёмная" : "☀️ Светлая"}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Масштаб шрифта</span>
            <div className="settings-control">
              {(["small", "medium", "large"] as FontScale[]).map((s) => (
                <button
                  key={s}
                  className={"btn" + (fontScale === s ? " active-btn" : "")}
                  onClick={() => applyFontScale(s)}
                >
                  {s === "small" ? "Мелкий" : s === "medium" ? "Средний" : "Крупный"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Торговля</div>
          <div className="settings-row">
            <span className="settings-label">Символ по умолчанию</span>
            <select
              className="settings-select"
              value={activeSymbol}
              onChange={(e) => setActiveSymbol(e.target.value)}
            >
              {DEFAULT_SYMBOLS.map((s) => (
                <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
              ))}
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-label">Таймфрейм по умолчанию</span>
            <select
              className="settings-select"
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf.value} value={tf.value}>{tf.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Paper-trading</div>
          <div className="settings-row">
            <span className="settings-label">Текущий баланс</span>
            <span className="settings-balance">
              {paperBalance.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label"></span>
            <button className="btn btn-danger" onClick={handleReset}>Сбросить аккаунт</button>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </Modal>
  );
}
