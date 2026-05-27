import { ChartPane } from "./ChartPane";
import type { Candle } from "../lib/types";
import type { LayoutKey } from "./MainWindow";

interface CellSpec {
  symbol: string;
  timeframe: string;
}

const CELLS: CellSpec[] = [
  { symbol: "BTCUSDT",  timeframe: "15m" },
  { symbol: "ETHUSDT",  timeframe: "1h"  },
  { symbol: "SOLUSDT",  timeframe: "5m"  },
  { symbol: "DOGEUSDT", timeframe: "15m" },
];

interface ChartMosaicProps {
  layout: LayoutKey;
  candles: Candle[];
  primarySymbol: string;
  primaryTimeframe: string;
}

export function ChartMosaic({ layout, candles, primarySymbol, primaryTimeframe }: ChartMosaicProps) {
  const count = layout === "1" ? 1 : layout === "2" ? 2 : 4;
  const cells: CellSpec[] = [
    { symbol: primarySymbol, timeframe: primaryTimeframe },
    ...CELLS.slice(1, count),
  ].slice(0, count);

  return (
    <div className={"chart-mosaic layout-" + layout}>
      {cells.map((cell, i) => {
        const last = candles[candles.length - 1];
        const first = candles[0];
        const ch = last && first && first.close ? ((last.close - first.close) / first.close) * 100 : 0;
        return (
          <div key={i} className={"chart-cell" + (i === 0 ? " active" : "")}>
            <div className="chart-cell-head">
              <span className="sym">{cell.symbol}</span>
              <span className="tf">{cell.timeframe}</span>
              {i === 0 && last && (
                <>
                  <span className="price">{last.close.toFixed(2)}</span>
                  <span className={"ch " + (ch >= 0 ? "up" : "dn")}>
                    {ch >= 0 ? "+" : ""}{ch.toFixed(2)}%
                  </span>
                </>
              )}
            </div>
            <div className="chart-host">
              {/* Primary cell shows live Bybit data; other cells share the same dataset for now */}
              <ChartPane data={candles} symbol={cell.symbol} timeframe={cell.timeframe} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
