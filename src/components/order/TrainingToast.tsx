// Non-blocking confirm shown for:
//   - the very first ⇧+click on the orderbook after enabling the dangerous shortcut
//     (one-time training pass; on confirm the gesture stops asking for confirmation)
//   - any market order whose USDT value crosses the configured threshold
//
// Lives in the bottom-right corner. Click "Отправить" runs venue.placeOrder
// with the stored request. "Отключить шорткат" only appears for shift-click-first.

import { useStore } from "../../lib/store";
import { venue } from "../../lib/execution/router";
import { fmtUsdt } from "../../lib/format";
import { logOk, logWarn } from "../../lib/eventBus";

function symbolBase(symbol: string): string {
  if (symbol.endsWith("USDT") || symbol.endsWith("USDC")) return symbol.slice(0, -4);
  if (symbol.endsWith("USD")) return symbol.slice(0, -3);
  return symbol;
}

export function TrainingToast() {
  const pc           = useStore((s) => s.pendingConfirm);
  const close        = useStore((s) => s.closePendingConfirm);
  const updateSet    = useStore((s) => s.updateSettings);
  const setLastQty   = useStore((s) => s.setLastUsedQty);

  if (!pc.open || !pc.request) return null;
  const req = pc.request;

  const submit = () => {
    try {
      venue.placeOrder(req);
      setLastQty(req.qty);
      logOk("order", `${req.side} ${req.qty} ${req.symbol} @ ${req.type}`);
    } catch (err) {
      logWarn("order", `не удалось разместить: ${String(err)}`);
    }
    close();
  };

  const disableShortcut = () => {
    updateSet({ dangerous: { shiftClickOrderbook: false } });
    close();
  };

  const sideUpper = req.side.toUpperCase();
  const sideColor = req.side === "buy" ? "var(--green)" : "var(--red)";

  return (
    <div className="training-toast" data-testid="training-toast">
      <div className="tt-row1">
        <b>
          {pc.kind === "shift-click-first" ? "⚡ Включён shift-click" : "⚠ Крупный market"}
        </b>
        <span className="dim">{pc.kind === "shift-click-first" ? "первый раз" : "подтверждение"}</span>
      </div>
      <div className="tt-row2">
        {pc.kind === "shift-click-first" ? (
          <>
            Жест <code>⇧ + клик</code> отправляет <b>market</b> без подтверждения.
            Этот раз — confirm. Дальше — сразу.
          </>
        ) : (
          <>
            Сумма ордера превышает порог подтверждения. Проверь параметры
            прежде чем подтвердить.
          </>
        )}
        <div className="tt-summary">
          Сейчас: <b style={{ color: sideColor }}>{sideUpper} {req.qty} {symbolBase(req.symbol)} @ {req.type}</b>
          {pc.estUsdt > 0 && <> ≈ <b>{fmtUsdt(pc.estUsdt)} USDT</b></>}
        </div>
      </div>
      <div className="tt-actions">
        {pc.kind === "shift-click-first" && (
          <button className="tt-btn dim" data-testid="training-toast-disable" onClick={disableShortcut}>
            Отключить шорткат
          </button>
        )}
        <button className="tt-btn" data-testid="training-toast-cancel" onClick={close}>Отмена</button>
        <button className="tt-btn primary" data-testid="training-toast-submit" onClick={submit}>
          Отправить
        </button>
      </div>
    </div>
  );
}
