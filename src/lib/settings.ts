// Centralised app settings — persisted in the Zustand store via `partialize`.

import { DEFAULT_FEE_SETTINGS, type FeeSettings } from "./execution/fees";
import { DEFAULT_SLIPPAGE_CONTEXT, type SlippageContextSettings } from "./execution/slippage";
import { DEFAULT_REJECTION_SETTINGS, type RejectionSettings } from "./execution/rejection";
import { DEFAULT_FUNDING_INTERVAL_MINUTES, TYPICAL_FUNDING_RATE } from "./execution/funding";

export type FontScale = "sm" | "md" | "lg";
export type ChartType = "candle" | "line" | "area";
export type HistoryDepth = 200 | 500 | 1000;
export type PnlMode    = "abs" | "pct";

export interface AppearanceSettings {
  // theme lives at the top-level store as before
  accentColor:        string;
  candleUpColor:      string;
  candleDownColor:    string;
  fontScale:          FontScale;
}

export interface ChartSettings {
  defaultChartType:   ChartType;
  defaultTimeframe:   string;       // bybit interval e.g. "15"
  historyDepth:       HistoryDepth;
  showVolume:         boolean;
  showGrid:           boolean;
  rightOffset:        number;       // bars after the last candle
}

export interface IndicatorDefaults {
  sma:       { period: number; color: string };
  ema:       { period: number; color: string };
  rsi:       { period: number; color: string };
  macd:      { fast: number; slow: number; signal: number; color: string };
  bollinger: { period: number; stdDev: number; color: string };
}

export interface DrawingSettings {
  defaultColor:               string;
  defaultLineWidth:           1 | 2 | 3 | 4;
  snapEnabled:                boolean;
  snapThresholdPx:            number;
  disableMagnetOnSelection:   boolean;   // turn off crosshair magnet when a drawing is selected
}

export type SlippageKind = "none" | "fixed_bps" | "spread_pct" | "volume_impact";

export interface SlippageSettings {
  kind:        SlippageKind;
  bps:         number;     // for kind=fixed_bps — basis points (1 bps = 0.01%)
  spreadPct:   number;     // for kind=spread_pct — fraction of bid-ask spread (0..1)
  impactK:     number;     // for kind=volume_impact — bps multiplier
  impactRefQty:number;     // reference qty for sqrt scaling
  // Added later — optional so old persist snapshots keep type-checking.
  context?:    SlippageContextSettings;   // hour-of-day / weekend / volatility multipliers
}

export interface FundingSettings {
  enabled:         boolean;
  intervalMinutes: number;    // BTCUSDT 480; some alts 240 or 60 — read per symbol
  fallbackRate:    number;    // used when the funding history has gaps
}

export interface PaperTradingSettings {
  initialBalance:    number;
  feeRate:           number;       // 0.001 = 0.1% — legacy flat rate, superseded by `fees`
  pnlMode:           PnlMode;
  slippage:          SlippageSettings;
  confirmThresholdLow:  number;    // < this → no confirm (USDT). Set 0 to always confirm.
  confirmThresholdHigh: number;    // ≥ this → modal confirm. Between low and high → undo toast.
  // Added later — optional so old persist snapshots keep type-checking.
  fees?:      FeeSettings;
  rejection?: RejectionSettings;
  funding?:   FundingSettings;
}

export interface DangerousShortcutsSettings {
  shiftClickOrderbook: boolean;    // ⇧+click on orderbook row → instant market
  quickBuySellKeys:    boolean;    // B / S → open popup with market & focused qty
}

export interface NotificationSettings {
  alertSound:        boolean;
  nativePush:        boolean;
  onCloseTrade:      boolean;
  onBotOrder:        boolean;
}

export interface NetworkSettings {
  backend:           "mainnet" | "testnet";
  wsReconnectMs:     number;
  restTimeoutMs:     number;
}

export type HistoryProvider = "bybit" | "binance" | "file";

export interface HistoryDbSettings {
  provider:          HistoryProvider;
  // How far back to keep candles in the IndexedDB cache, per symbol/tf.
  depthYears:        number;          // 0.5 / 1 / 2 / 5 / 0 (unlimited)
  backgroundBackfill:boolean;
  maxCacheMb:        number;          // soft cap on cache size
}

export interface Settings {
  appearance:   AppearanceSettings;
  chart:        ChartSettings;
  indicators:   IndicatorDefaults;
  drawings:     DrawingSettings;
  paperTrading: PaperTradingSettings;
  dangerous:    DangerousShortcutsSettings;
  notifications:NotificationSettings;
  network:      NetworkSettings;
  historyDb:    HistoryDbSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    accentColor:     "#f0b90b",
    candleUpColor:   "#26a69a",
    candleDownColor: "#ef5350",
    fontScale:       "md",
  },
  chart: {
    defaultChartType: "candle",
    defaultTimeframe: "15",
    historyDepth:     1000,
    showVolume:       true,
    showGrid:         true,
    rightOffset:      6,
  },
  indicators: {
    sma:       { period: 20, color: "#f0b90b" },
    ema:       { period: 20, color: "#58a6ff" },
    rsi:       { period: 14, color: "#bb86fc" },
    macd:      { fast: 12, slow: 26, signal: 9, color: "#26a69a" },
    bollinger: { period: 20, stdDev: 2, color: "#ef5350" },
  },
  drawings: {
    defaultColor:             "#f0b90b",
    defaultLineWidth:         1,
    snapEnabled:              true,
    snapThresholdPx:          10,
    disableMagnetOnSelection: true,
  },
  paperTrading: {
    initialBalance: 10000,
    feeRate:        0.001,
    pnlMode:        "abs",
    slippage: {
      kind:         "fixed_bps",
      bps:          2,        // 2 bps = 0.02% — реалистично для liquid spot pairs
      spreadPct:    0.5,
      impactK:      5,
      impactRefQty: 1,
      context:      { ...DEFAULT_SLIPPAGE_CONTEXT, deadHoursUtc: [...DEFAULT_SLIPPAGE_CONTEXT.deadHoursUtc] },
    },
    confirmThresholdLow:  100,
    confirmThresholdHigh: 1000,
    fees:      { ...DEFAULT_FEE_SETTINGS },
    rejection: { ...DEFAULT_REJECTION_SETTINGS, stressWindows: [] },
    funding: {
      enabled:         true,
      intervalMinutes: DEFAULT_FUNDING_INTERVAL_MINUTES,
      fallbackRate:    TYPICAL_FUNDING_RATE,
    },
  },
  dangerous: {
    shiftClickOrderbook: false,
    quickBuySellKeys:    false,
  },
  notifications: {
    alertSound:   true,
    nativePush:   false,
    onCloseTrade: true,
    onBotOrder:   false,
  },
  network: {
    backend:       "mainnet",
    wsReconnectMs: 3000,
    restTimeoutMs: 10000,
  },
  historyDb: {
    provider:           "bybit",
    depthYears:         1,
    backgroundBackfill: false,
    maxCacheMb:         500,
  },
};
