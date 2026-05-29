import { useEffect, useRef } from "react";
import { INDICATORS } from "../lib/indicators/registry";
import type { IndicatorKind } from "../lib/indicators/base";

interface Props {
  onPick:   (kind: IndicatorKind) => void;
  onClose:  () => void;
}

const ORDER: IndicatorKind[] = ["sma", "ema", "rsi", "macd", "bollinger", "stochastic", "atr", "fractals"];

export function IndicatorPicker({ onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="indicator-picker">
      <div className="indicator-picker-head">
        Добавить индикатор<span style={{ color: "var(--fg-mute)", marginLeft: 8, fontSize: 10 }}>Esc — закрыть</span>
      </div>
      {ORDER.map((kind) => {
        const def = INDICATORS[kind];
        return (
          <div key={kind}
               className="indicator-picker-row"
               onClick={() => { onPick(kind); onClose(); }}>
            <span className="ind-color" style={{ background: def.defaultColor }} />
            <span className="ind-name">{def.name}</span>
            <span className="ind-region">{def.region === "overlay" ? "overlay" : "pane"}</span>
          </div>
        );
      })}
    </div>
  );
}
