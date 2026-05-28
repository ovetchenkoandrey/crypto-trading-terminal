import { useState } from "react";
import { Modal } from "./Modal";
import type { ActiveIndicator } from "../lib/store";
import { getIndicatorDef } from "../lib/indicators/registry";

interface IndicatorParamsDialogProps {
  indicator: ActiveIndicator;
  onSave: (partial: Partial<ActiveIndicator>) => void;
  onClose: () => void;
}

const PARAM_LABELS_RU: Record<string, string> = {
  period: "Период",
  fast: "Быстрый период",
  slow: "Медленный период",
  signal: "Сигнальный период",
  stdDev: "Отклонение (σ)",
  source: "Источник",
};

const LINE_WIDTHS = [1, 2, 3, 4];

export function IndicatorParamsDialog({ indicator, onSave, onClose }: IndicatorParamsDialogProps) {
  const def = getIndicatorDef(indicator.kind);
  const [params, setParams] = useState<Record<string, number | string>>({ ...indicator.params });
  const [color, setColor] = useState<string>(indicator.color ?? def?.defaultColor ?? "#f0b90b");
  const [lineWidth, setLineWidth] = useState<number>(indicator.lineWidth ?? 1);

  if (!def) {
    return (
      <Modal title="Ошибка" onClose={onClose}>
        <div style={{ padding: 16 }}>Неизвестный индикатор: {indicator.kind}</div>
      </Modal>
    );
  }

  const handleSave = () => {
    onSave({ params, color, lineWidth });
    onClose();
  };

  const handleReset = () => {
    setParams({ ...def.defaultParams });
    setColor(def.defaultColor);
    setLineWidth(1);
  };

  const numericKeys = Object.keys(params).filter((k) => typeof params[k] === "number");

  return (
    <Modal title={`${def.name} — параметры`} onClose={onClose} width={420}>
      <div className="ind-cfg">
        {numericKeys.map((key) => (
          <label key={key} className="ind-cfg-row">
            <span>{PARAM_LABELS_RU[key] ?? key}</span>
            <input
              type="number"
              min={1}
              step={key === "stdDev" ? 0.1 : 1}
              value={params[key] as number}
              onChange={(e) => setParams((p) => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
            />
          </label>
        ))}

        <label className="ind-cfg-row">
          <span>Цвет линии</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 40, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", background: "transparent" }}
            />
            <code style={{ color: "var(--fg-dim)", fontSize: 11 }}>{color}</code>
          </div>
        </label>

        <label className="ind-cfg-row">
          <span>Толщина линии</span>
          <select value={lineWidth} onChange={(e) => setLineWidth(parseInt(e.target.value, 10))}>
            {LINE_WIDTHS.map((w) => (
              <option key={w} value={w}>{w}px</option>
            ))}
          </select>
        </label>

        <div className="ind-cfg-buttons">
          <button className="btn" onClick={handleReset} title="Сбросить к значениям по умолчанию">
            Сбросить
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Отмена</button>
          <button
            className="btn"
            style={{ background: "var(--accent)", color: "#1a1a1a", borderColor: "var(--accent)", fontWeight: 600 }}
            onClick={handleSave}
          >
            Применить
          </button>
        </div>
      </div>
    </Modal>
  );
}
