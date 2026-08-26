import { useState } from "react";
import { useStore } from "../lib/store";
import type { BotConfig } from "../lib/store";
import { BotConfigDialog } from "./bots/BotConfigDialog";
import { getBotFactory } from "../lib/bots/registry";
import { closeAllPositions, exportHistoryCsv } from "../lib/scripts";

function dragStart(e: React.DragEvent, kind: string) {
  e.dataTransfer.setData("application/x-indicator", JSON.stringify({ kind }));
  e.dataTransfer.effectAllowed = "copy";
}

const DRAGGABLE_INDICATORS: { label: string; kind: string }[] = [
  { label: "Moving Average", kind: "sma" },
  { label: "EMA", kind: "ema" },
  { label: "RSI", kind: "rsi" },
  { label: "MACD", kind: "macd" },
  { label: "Bollinger Bands", kind: "bollinger" },
  { label: "Stochastic", kind: "stochastic" },
  { label: "ATR", kind: "atr" },
  { label: "Fractals", kind: "fractals" },
];

const BOT_TEMPLATES: { label: string; kind: string; available: boolean }[] = [
  { label: "Grid Bot",        kind: "grid", available: true  },
  { label: "DCA Strategy",    kind: "dca",  available: true  },
  { label: "Ночной mean reversion", kind: "night-mr", available: true },
  { label: "MA Crossover EA", kind: "mac",  available: false },
  { label: "Mean Reversion",  kind: "mr",   available: false },
];

function newBotFromTemplate(kind: string, activeSymbol: string): BotConfig | null {
  const factory = getBotFactory(kind);
  if (!factory) return null;
  return {
    id: "bot-" + Math.random().toString(36).slice(2, 10),
    kind,
    symbol: activeSymbol,
    params: { ...factory.defaultParams },
    status: "stopped",
  };
}

export function Navigator() {
  const botConfigs   = useStore((s) => s.botConfigs);
  const activeSymbol = useStore((s) => s.activeSymbol);
  const [openBot, setOpenBot] = useState<BotConfig | null>(null);

  return (
    <>
      <div className="panel-title">
        <span className="dot" />
        Навигатор
      </div>
      <div className="nav-tree">
        <div className="nav-cat"><span className="chev">▾</span>📁 Индикаторы</div>
        {DRAGGABLE_INDICATORS.map(({ label, kind }) => (
          <div
            key={kind}
            className="nav-item nav-item-draggable"
            draggable
            data-indicator-kind={kind}
            onDragStart={(e) => dragStart(e, kind)}
          >
            <span className="ico">📈</span>{label}
          </div>
        ))}
        <div className="nav-item disabled"><span className="ico">📈</span>Volume Profile</div>

        <div className="nav-cat"><span className="chev">▾</span>🤖 Создать бота</div>
        {BOT_TEMPLATES.map(({ label, kind, available }) => (
          <div
            key={kind}
            className={"nav-item" + (available ? "" : " disabled")}
            onClick={() => {
              if (!available) return;
              const cfg = newBotFromTemplate(kind, activeSymbol);
              if (cfg) setOpenBot(cfg);
            }}
            title={available ? "Создать новый экземпляр" : "Скоро"}
          >
            <span className="ico">🤖</span>{label}
          </div>
        ))}

        {botConfigs.length > 0 && (
          <>
            <div className="nav-cat"><span className="chev">▾</span>⚙ Активные боты ({botConfigs.length})</div>
            {botConfigs.map((b) => (
              <div
                key={b.id}
                className="nav-item"
                onClick={() => setOpenBot(b)}
                title="Открыть настройки"
              >
                <span className="ico">🤖</span>
                {(getBotFactory(b.kind)?.name ?? b.kind)} · {b.symbol}
                {b.status === "running" && <span className="badge running">RUN</span>}
              </div>
            ))}
          </>
        )}

        <div className="nav-cat"><span className="chev">▾</span>📜 Скрипты</div>
        <div className="nav-item" onClick={closeAllPositions} title="Закрыть все открытые позиции по рынку">
          <span className="ico">📜</span>close_all_positions
        </div>
        <div className="nav-item" onClick={exportHistoryCsv} title="Скачать историю сделок в CSV">
          <span className="ico">📜</span>export_history_csv
        </div>
      </div>

      {openBot && (
        <BotConfigDialog bot={openBot} onClose={() => setOpenBot(null)} />
      )}
    </>
  );
}
