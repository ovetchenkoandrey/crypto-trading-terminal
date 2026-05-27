import { useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../lib/store";
import type { BotConfig } from "../../lib/store";
import { getBotFactory } from "../../lib/bots/registry";
import { botManager } from "../../lib/bots/manager";
import { DEFAULT_SYMBOLS } from "../../lib/symbols";

interface BotConfigDialogProps {
  bot: BotConfig;
  onClose: () => void;
}

function uid(): string {
  return "bot-" + Math.random().toString(36).slice(2, 10);
}

export function BotConfigDialog({ bot: initial, onClose }: BotConfigDialogProps) {
  const upsertBot = useStore((s) => s.upsertBot);
  const removeBot = useStore((s) => s.removeBot);
  const factory = getBotFactory(initial.kind);

  const [symbol, setSymbol] = useState(initial.symbol);
  const [params, setParams] = useState<Record<string, number | string>>({ ...initial.params });

  if (!factory) {
    return (
      <Modal title="Ошибка" onClose={onClose}>
        <div style={{ padding: 16 }}>Неизвестный тип бота: {initial.kind}</div>
      </Modal>
    );
  }

  const isNew = !useStore.getState().botConfigs.some((b) => b.id === initial.id);
  const running = botManager.isRunning(initial.id);

  const save = (): BotConfig => {
    const cfg: BotConfig = {
      ...initial,
      id: initial.id || uid(),
      symbol,
      params,
      status: running ? "running" : "stopped",
    };
    upsertBot(cfg);
    return cfg;
  };

  const handleStart = () => {
    if (running) {
      botManager.stop(initial.id);
    } else {
      const cfg = save();
      botManager.start(cfg.id);
    }
    onClose();
  };

  const handleSave = () => { save(); onClose(); };

  const handleDelete = () => {
    if (running) botManager.stop(initial.id);
    removeBot(initial.id);
    onClose();
  };

  return (
    <Modal title={`${factory.name}${isNew ? " (новый)" : ""}`} onClose={onClose}>
      <div className="bot-cfg">
        <label className="bot-cfg-row">
          <span>Символ</span>
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {DEFAULT_SYMBOLS.map((s) => (
              <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
            ))}
          </select>
        </label>
        {factory.paramSpec.map((spec) => (
          <label key={spec.key} className="bot-cfg-row">
            <span>{spec.label}</span>
            <input
              type={spec.type}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={params[spec.key] as number | string}
              onChange={(e) => setParams((p) => ({
                ...p,
                [spec.key]: spec.type === "number" ? parseFloat(e.target.value) : e.target.value,
              }))}
            />
          </label>
        ))}

        <div className="bot-cfg-status">
          Статус: <strong style={{ color: running ? "var(--green)" : "var(--fg-mute)" }}>
            {running ? "RUNNING" : "STOPPED"}
          </strong>
        </div>

        <div className="bot-cfg-buttons">
          {!isNew && (
            <button className="btn" style={{ color: "var(--red)" }} onClick={handleDelete}>Удалить</button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={handleSave}>Сохранить</button>
          <button
            className="btn"
            style={{
              background: running ? "var(--red)" : "var(--green)",
              color: "white",
              borderColor: "transparent",
              fontWeight: 600,
            }}
            onClick={handleStart}
          >
            {running ? "Остановить" : "Старт"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
