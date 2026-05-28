// Export / import the parts of the store that describe the workspace layout.
// Indicators, drawings, chart types, theme — yes. Market data and live caches — no.

import { useStore } from "./store";
import type { MosaicCell, PanelsState, LayoutKey, Theme } from "./store";
import type { Settings } from "./settings";
import type { DrawingTool } from "./drawings/types";
import { logOk, logWarn } from "./eventBus";

interface LayoutFile {
  version: 1;
  exportedAt: number;
  app: "trading-app";
  layout: {
    theme:            Theme;
    panels:           PanelsState;
    layout:           LayoutKey;
    activeCellIndex:  number;
    mosaicCells:      MosaicCell[];
    currentTool:      DrawingTool;
    settings:         Settings;
  };
}

export function exportLayout(): void {
  const s = useStore.getState();
  const file: LayoutFile = {
    version: 1,
    exportedAt: Date.now(),
    app: "trading-app",
    layout: {
      theme:           s.theme,
      panels:          s.panels,
      layout:          s.layout,
      activeCellIndex: s.activeCellIndex,
      mosaicCells:     s.mosaicCells,
      currentTool:     s.currentTool,
      settings:        s.settings,
    },
  };
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.download = `trading-app-layout-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  logOk("layout", "exported");
}

export function importLayoutFromFile(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.style.display = "none";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<LayoutFile>;
      if (parsed.app !== "trading-app" || !parsed.layout) {
        logWarn("layout", "не похоже на файл Trading App");
        return;
      }
      if (!window.confirm("Заменить текущую раскладку и настройки на содержимое файла?")) return;

      const L = parsed.layout;
      useStore.setState({
        theme:           L.theme           ?? "dark",
        panels:          L.panels           ?? { marketWatch: false, orderBook: true, navigator: true, terminal: true },
        layout:          L.layout           ?? "1",
        activeCellIndex: L.activeCellIndex  ?? 0,
        mosaicCells:     L.mosaicCells      ?? [],
        currentTool:     L.currentTool      ?? "cursor",
        settings:        L.settings         ?? useStore.getState().settings,
      });
      logOk("layout", "imported");
    } catch (err) {
      logWarn("layout", `ошибка чтения: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  document.body.appendChild(input);
  input.click();
  document.body.removeChild(input);
}
