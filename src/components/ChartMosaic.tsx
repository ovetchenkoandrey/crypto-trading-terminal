import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { ChartPane } from "./ChartPane";
import { fetchKlines } from "../lib/bybit";
import { ws } from "../lib/bybitWs";
import { tfLabel } from "../lib/symbols";
import { fmtPrice, fmtPercent } from "../lib/format";
import { getPricePrecision } from "../lib/symbols";
import { logError } from "../lib/eventBus";
import type { Interval } from "../lib/types";
import { SymbolPicker } from "./SymbolPicker";
import { getIndicatorDef } from "../lib/indicators/registry";

export function ChartMosaic() {
  const layout    = useStore((s) => s.layout);
  const cells     = useStore((s) => s.mosaicCells);
  const candles   = useStore((s) => s.candles);
  const tickers   = useStore((s) => s.tickers);
  const setCandles      = useStore((s) => s.setCandles);
  const setMosaicCell   = useStore((s) => s.setMosaicCell);
  const addIndicator    = useStore((s) => s.addIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const updateIndicator = useStore((s) => s.updateIndicator);

  const [activeCell, setActiveCell] = useState(0);
  const [pickerCell, setPickerCell] = useState<number | null>(null);

  const count   = layout === "1" ? 1 : layout === "2" ? 2 : 4;
  const visible = cells.slice(0, count);

  // For each visible cell, ensure we have klines loaded and WS subscribed
  useEffect(() => {
    const wantedTopics = new Set<string>();
    for (const c of visible) {
      const key = `${c.symbol}.${c.timeframe}`;
      wantedTopics.add(`kline.${c.timeframe}.${c.symbol}`);
      if (!candles[key] || candles[key].length === 0) {
        fetchKlines(c.symbol, c.timeframe as Interval, 200)
          .then((data) => setCandles(key, data))
          .catch((err: unknown) => logError("rest", `klines ${c.symbol}.${c.timeframe}: ${err instanceof Error ? err.message : String(err)}`));
      }
      ws.subscribe(`kline.${c.timeframe}.${c.symbol}`);
    }
    return () => {
      for (const c of visible) {
        const topic = `kline.${c.timeframe}.${c.symbol}`;
        if (!wantedTopics.has(topic)) ws.unsubscribe(topic);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((c) => `${c.symbol}.${c.timeframe}`).join("|")]);

  return (
    <>
      <div className={"chart-mosaic layout-" + layout}>
        {visible.map((cell, i) => {
          const key    = `${cell.symbol}.${cell.timeframe}`;
          const data   = candles[key] ?? [];
          const ticker = tickers[cell.symbol];
          const precision = getPricePrecision(cell.symbol, ticker?.lastPrice);
          const ch  = ticker?.change24h ?? 0;
          const dir = ch >= 0 ? "up" : "dn";
          const isActive = i === activeCell;

          return (
            <div
              key={`${i}-${key}`}
              className={"chart-cell" + (isActive ? " active" : "")}
              onClick={() => setActiveCell(i)}
            >
              <div
                className="chart-cell-head"
                onDoubleClick={() => setPickerCell(i)}
              >
                <span className="sym">{cell.symbol}</span>
                <span className="tf">{tfLabel(cell.timeframe)}</span>
                {ticker && (
                  <>
                    <span className="price">{fmtPrice(ticker.lastPrice, precision)}</span>
                    <span className={"ch " + dir}>{fmtPercent(ch)}</span>
                  </>
                )}
                <button
                  className="cell-picker-caret"
                  title="Выбрать символ"
                  onClick={(e) => { e.stopPropagation(); setPickerCell(i); }}
                >
                  ▾
                </button>
              </div>
              <div className="chart-host">
                <ChartPane
                  data={data}
                  symbol={cell.symbol}
                  timeframe={tfLabel(cell.timeframe)}
                  indicators={cell.indicators}
                  onAddIndicator={(kind) => {
                    const def = getIndicatorDef(kind);
                    if (!def) return;
                    addIndicator(i, {
                      id: crypto.randomUUID(),
                      kind,
                      params: { ...def.defaultParams },
                      color: def.defaultColor,
                    });
                  }}
                  onRemoveIndicator={(id) => removeIndicator(i, id)}
                  onUpdateIndicator={(id, partial) => updateIndicator(i, id, partial)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {pickerCell !== null && (
        <SymbolPicker
          currentSymbol={cells[pickerCell]?.symbol ?? ""}
          currentTimeframe={cells[pickerCell]?.timeframe ?? "15"}
          onSelect={(sym) => {
            setMosaicCell(pickerCell, { symbol: sym });
            setPickerCell(null);
          }}
          onSelectTf={(tf) => {
            setMosaicCell(pickerCell, { timeframe: tf });
          }}
          onCancel={() => setPickerCell(null)}
        />
      )}
    </>
  );
}
