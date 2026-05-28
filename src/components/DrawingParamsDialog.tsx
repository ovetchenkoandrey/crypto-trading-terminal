import { useState } from "react";
import { Modal } from "./Modal";
import type { Drawing } from "../lib/store";

interface Props {
  drawing: Drawing;
  onSave:  (partial: Partial<Drawing>) => void;
  onClose: () => void;
  onDelete?: () => void;
}

const LINE_WIDTHS = [1, 2, 3, 4];

function kindLabel(kind: Drawing["kind"]): string {
  switch (kind) {
    case "hline":     return "Горизонтальная линия";
    case "trendline": return "Линия тренда";
    case "fib":       return "Фибоначчи";
    case "text":      return "Текст";
  }
}

export function DrawingParamsDialog({ drawing, onSave, onClose, onDelete }: Props) {
  const [color,     setColor]     = useState<string>(drawing.color);
  const [lineWidth, setLineWidth] = useState<number>(drawing.lineWidth ?? 1);
  const [text,      setText]      = useState<string>(drawing.kind === "text" ? drawing.text : "");

  const save = () => {
    const partial: Partial<Drawing> = { color, lineWidth } as Partial<Drawing>;
    if (drawing.kind === "text") {
      (partial as Partial<typeof drawing>).text = text;
    }
    onSave(partial);
    onClose();
  };

  return (
    <Modal title={kindLabel(drawing.kind) + " — параметры"} onClose={onClose} width={380}>
      <div className="ind-cfg">
        <label className="ind-cfg-row">
          <span>Цвет линии</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                   style={{ width: 40, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", background: "transparent" }} />
            <code style={{ color: "var(--fg-dim)", fontSize: 11 }}>{color}</code>
          </div>
        </label>

        {drawing.kind !== "text" && (
          <label className="ind-cfg-row">
            <span>Толщина линии</span>
            <select value={lineWidth} onChange={(e) => setLineWidth(parseInt(e.target.value, 10))}>
              {LINE_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}
            </select>
          </label>
        )}

        {drawing.kind === "text" && (
          <label className="ind-cfg-row">
            <span>Текст</span>
            <input type="text" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}

        <div className="ind-cfg-buttons">
          {onDelete && (
            <button className="btn" style={{ color: "var(--red)" }} onClick={() => { onDelete(); onClose(); }}>
              Удалить
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn"
                  style={{ background: "var(--accent)", color: "#1a1a1a", borderColor: "var(--accent)", fontWeight: 600 }}
                  onClick={save}>
            Применить
          </button>
        </div>
      </div>
    </Modal>
  );
}
