import { useStore } from "./store";
import { paperEngine } from "./paper/engine";
import { logOk, logWarn } from "./eventBus";

export function closeAllPositions(): void {
  const positions = useStore.getState().paperPositions;
  if (positions.length === 0) {
    logOk("script", "нет открытых позиций");
    return;
  }
  if (!window.confirm(`Закрыть все ${positions.length} открытых позиций по рыночной цене?`)) return;
  let closed = 0;
  for (const p of positions) {
    try { paperEngine.closePosition(p.id); closed++; } catch (e) {
      logWarn("script", `не удалось закрыть ${p.symbol}: ${String(e)}`);
    }
  }
  logOk("script", `закрыто ${closed} позиций`);
}

export function exportHistoryCsv(): void {
  const history = useStore.getState().paperHistory;
  if (history.length === 0) {
    logWarn("script", "история сделок пуста");
    return;
  }
  const headers = ["ts_iso", "symbol", "side", "qty", "entryPrice", "exitPrice", "pnl", "botId"];
  const rows = history.map((t) => [
    new Date(t.ts).toISOString(),
    t.symbol, t.side, t.qty, t.entryPrice, t.exitPrice, t.pnl.toFixed(4), t.botId ?? "",
  ]);
  const csv = [headers, ...rows].map((r) => r.map((v) => {
    const s = String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `paper-trading-history-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  logOk("script", `экспортировано ${history.length} сделок`);
}
