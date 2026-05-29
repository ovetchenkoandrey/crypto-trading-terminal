import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Candle } from "./types";
import type { SymbolMeta } from "./symbols";
import { DEFAULT_SYMBOLS } from "./symbols";
import type { Drawing, DrawingTool } from "./drawings/types";
export type { Drawing, DrawingTool } from "./drawings/types";
import type { Settings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings";
export type { Settings } from "./settings";
import type { VenueMode } from "./execution/types";
export type { VenueMode } from "./execution/types";

export type PanelKey = "marketWatch" | "orderBook" | "navigator" | "terminal";
export type PanelsState = Record<PanelKey, boolean>;
export type LayoutKey = "1" | "2" | "4";
export type Theme = "dark" | "light";

export interface MosaicCell {
  symbol: string;
  timeframe: string;
  indicators: ActiveIndicator[];
  drawings: Drawing[];
  chartType?: import("./settings").ChartType;   // candle | line | area (optional → defaults to settings.chart.defaultChartType)
}

export interface ActiveIndicator {
  id: string;             // unique instance id
  kind: string;           // e.g. "sma", "ema", "rsi"
  params: Record<string, number | string>;
  color?: string;
  lineWidth?: number;     // 1..4, default 1
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bid1: number;
  ask1: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  updatedAt: number;
}

export interface OrderbookLevel {
  price: number;
  qty: number;
}

export interface Orderbook {
  symbol: string;
  asks: OrderbookLevel[];     // sorted ascending by price
  bids: OrderbookLevel[];     // sorted descending by price
  updatedAt: number;
}

export interface JournalEntry {
  ts: number;
  level: "info" | "ok" | "warn" | "error";
  source: string;
  msg: string;
}

// Paper trading (E1D)
export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop";
export type OrderStatus = "pending" | "filled" | "cancelled";

export interface PaperOrder {
  id: string;
  ts: number;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number;            // limit price (for limit/stop)
  qty: number;
  status: OrderStatus;
  filledPrice?: number;
  filledTs?: number;
  botId?: string;            // owning bot, if any
}

export interface PaperPosition {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  qty: number;
  openedTs: number;
  botId?: string;
}

export interface PaperTrade {
  id: string;
  ts: number;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  botId?: string;
}

export interface BotConfig {
  id: string;
  kind: string;             // matches a BotFactory.kind in lib/bots/registry.ts
  symbol: string;
  params: Record<string, number | string>;
  status: "stopped" | "running";
}

export interface ConnectionState {
  connected: boolean;
  latencyMs: number | null;
}

interface PersistedSlice {
  theme: Theme;
  panels: PanelsState;
  activeSymbol: string;            // mirror of mosaicCells[activeCellIndex].symbol
  timeframe: string;               // mirror of mosaicCells[activeCellIndex].timeframe
  activeCellIndex: number;
  layout: LayoutKey;
  mosaicCells: MosaicCell[];
  watchlist: string[];
  currentTool: DrawingTool;        // active drawing tool (top-level; affects whichever cell user clicks in)
  settings: Settings;
  paperBalance: number;
  paperPositions: PaperPosition[];
  paperOrders: PaperOrder[];
  paperHistory: PaperTrade[];
  botConfigs: BotConfig[];
  venueMode: VenueMode;            // which execution backend is active app-wide
  firstShiftClickToastShown: boolean; // training confirm on the very first ⇧+click after enabling
  lastUsedQty: number;             // remembered qty for quick reuse (B/S keys, shift-click)
}

/**
 * Volatile (in-memory only) state for the Order popup.
 * `anchor` is the screen-space point near which the popup should appear; if null,
 * the popup is centred over the active chart cell.
 */
export interface OrderPopupState {
  open:    boolean;
  anchor:  { x: number; y: number } | null;
  defaults: {
    symbol:    string;
    side?:     Side;            // undefined → user must choose
    type:      OrderType;
    price?:    number;          // undefined for market
    qty?:      number;          // undefined → empty input
    advanced?: boolean;         // open with advanced section expanded
    focusQty?: boolean;         // focus + select qty input on mount (for B/S quick keys)
  };
}

interface VolatileSlice {
  tickers: Record<string, Ticker>;
  orderbook: Orderbook | null;
  candles: Record<string, Candle[]>;
  journal: JournalEntry[];
  connection: ConnectionState;
  allSymbols: SymbolMeta[];          // loaded from Bybit on startup (spot + linear)
  orderPopup: OrderPopupState;
}

interface Actions {
  setTheme: (t: Theme) => void;
  togglePanel: (k: PanelKey) => void;
  setActiveSymbol: (s: string) => void;
  setTimeframe: (tf: string) => void;
  setActiveCellIndex: (i: number) => void;
  setLayout: (l: LayoutKey) => void;
  setMosaicCell: (i: number, partial: Partial<MosaicCell>) => void;
  addIndicator: (cellIndex: number, ind: ActiveIndicator) => void;
  removeIndicator: (cellIndex: number, id: string) => void;
  updateIndicator: (cellIndex: number, id: string, partial: Partial<ActiveIndicator>) => void;

  setCurrentTool: (t: DrawingTool) => void;
  addDrawing: (cellIndex: number, d: Drawing) => void;
  removeDrawing: (cellIndex: number, id: string) => void;
  updateDrawing: (cellIndex: number, id: string, partial: Partial<Drawing>) => void;
  clearDrawings: (cellIndex: number) => void;

  updateTicker: (t: Ticker) => void;
  setOrderbook: (ob: Orderbook | null) => void;
  applyOrderbookDelta: (symbol: string, asks: [string, string][], bids: [string, string][], ts: number) => void;
  setCandles: (key: string, candles: Candle[]) => void;
  updateLastCandle: (key: string, c: Candle) => void;

  setConnected: (b: boolean) => void;
  setLatency: (ms: number) => void;

  pushJournal: (e: JournalEntry) => void;
  clearJournal: () => void;

  // Paper trading
  setPaperBalance: (v: number) => void;
  setPaperOrders: (o: PaperOrder[]) => void;
  setPaperPositions: (p: PaperPosition[]) => void;
  setPaperHistory: (h: PaperTrade[]) => void;
  resetPaperAccount: () => void;
  upsertBot: (b: BotConfig) => void;
  removeBot: (id: string) => void;

  setAllSymbols: (arr: SymbolMeta[]) => void;

  updateSettings: (partial: PartialDeep<Settings>) => void;
  resetSettings: () => void;

  setVenueMode: (mode: VenueMode) => void;

  openOrderPopup: (defaults: OrderPopupState["defaults"], anchor?: { x: number; y: number } | null) => void;
  closeOrderPopup: () => void;
  setLastUsedQty: (qty: number) => void;
  markFirstShiftClickToastShown: () => void;
}

// minimal recursive partial for settings updates
type PartialDeep<T> = T extends object ? { [K in keyof T]?: PartialDeep<T[K]> } : T;

type Store = PersistedSlice & VolatileSlice & Actions;

const DEFAULT_PERSISTED: PersistedSlice = {
  theme: "dark",
  panels: { marketWatch: true, orderBook: true, navigator: true, terminal: true },
  activeSymbol: "BTCUSDT",
  timeframe: "15",
  activeCellIndex: 0,
  layout: "1",
  mosaicCells: [
    { symbol: "BTCUSDT",  timeframe: "15", indicators: [], drawings: [] },
    { symbol: "ETHUSDT",  timeframe: "15", indicators: [], drawings: [] },
    { symbol: "SOLUSDT",  timeframe: "15", indicators: [], drawings: [] },
    { symbol: "DOGEUSDT", timeframe: "15", indicators: [], drawings: [] },
  ],
  currentTool: "cursor",
  watchlist: ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","DOTUSDT","LINKUSDT","MATICUSDT","ATOMUSDT"],
  paperBalance: 10000,
  paperPositions: [],
  paperOrders: [],
  paperHistory: [],
  botConfigs: [],
  venueMode: "paper",
  firstShiftClickToastShown: false,
  lastUsedQty: 0,
  settings: DEFAULT_SETTINGS,
};

// deep-merge helper for partial settings updates
function mergeDeep<T>(base: T, patch: unknown): T {
  if (typeof base !== "object" || base === null) return patch as T;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const p = patch as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    const bv = (base as Record<string, unknown>)[k];
    const pv = p[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = mergeDeep(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out as T;
}

const DEFAULT_VOLATILE: VolatileSlice = {
  tickers: {},
  orderbook: null,
  candles: {},
  journal: [],
  connection: { connected: false, latencyMs: null },
  allSymbols: DEFAULT_SYMBOLS,        // fallback until REST loads the full list
  orderPopup: { open: false, anchor: null, defaults: { symbol: "BTCUSDT", type: "market" } },
};

function sortLevels(side: "asks" | "bids", levels: OrderbookLevel[]): OrderbookLevel[] {
  return [...levels].sort((a, b) => side === "asks" ? a.price - b.price : b.price - a.price);
}

export const useStore = create<Store>()(
  persist(
    (set) => ({
      ...DEFAULT_PERSISTED,
      ...DEFAULT_VOLATILE,

      setTheme: (t) => set({ theme: t }),
      togglePanel: (k) => set((s) => ({ panels: { ...s.panels, [k]: !s.panels[k] } })),
      setActiveSymbol: (sym) => set((s) => {
        const idx = s.activeCellIndex;
        const cells = [...s.mosaicCells];
        const cell = cells[idx];
        if (!cell) return s;
        cells[idx] = { ...cell, symbol: sym };
        return { activeSymbol: sym, mosaicCells: cells };
      }),
      setTimeframe: (tf) => set((s) => {
        const idx = s.activeCellIndex;
        const cells = [...s.mosaicCells];
        const cell = cells[idx];
        if (!cell) return s;
        cells[idx] = { ...cell, timeframe: tf };
        return { timeframe: tf, mosaicCells: cells };
      }),
      setActiveCellIndex: (i) => set((s) => {
        const cell = s.mosaicCells[i];
        if (!cell) return s;
        // Top-level activeSymbol/timeframe mirror the now-active cell
        return { activeCellIndex: i, activeSymbol: cell.symbol, timeframe: cell.timeframe };
      }),
      setLayout: (l) => set({ layout: l }),
      setMosaicCell: (i, partial) => set((s) => {
        const cells = [...s.mosaicCells];
        cells[i] = { ...cells[i], ...partial };
        const update: Partial<Store> = { mosaicCells: cells };
        // Mirror to top-level only if changing the currently-active cell
        if (i === s.activeCellIndex) {
          if (partial.symbol) update.activeSymbol = partial.symbol;
          if (partial.timeframe) update.timeframe = partial.timeframe;
        }
        return update;
      }),
      addIndicator: (cellIndex, ind) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = { ...cell, indicators: [...cell.indicators, ind] };
        return { mosaicCells: cells };
      }),
      removeIndicator: (cellIndex, id) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = { ...cell, indicators: cell.indicators.filter((i) => i.id !== id) };
        return { mosaicCells: cells };
      }),
      updateIndicator: (cellIndex, id, partial) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = {
          ...cell,
          indicators: cell.indicators.map((i) => (i.id === id ? { ...i, ...partial } : i)),
        };
        return { mosaicCells: cells };
      }),

      setCurrentTool: (t) => set({ currentTool: t }),
      addDrawing: (cellIndex, d) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = { ...cell, drawings: [...(cell.drawings ?? []), d] };
        return { mosaicCells: cells };
      }),
      removeDrawing: (cellIndex, id) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = { ...cell, drawings: (cell.drawings ?? []).filter((d) => d.id !== id) };
        return { mosaicCells: cells };
      }),
      updateDrawing: (cellIndex, id, partial) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = {
          ...cell,
          drawings: (cell.drawings ?? []).map((d) => (d.id === id ? ({ ...d, ...partial } as Drawing) : d)),
        };
        return { mosaicCells: cells };
      }),
      clearDrawings: (cellIndex) => set((s) => {
        const cells = [...s.mosaicCells];
        const cell = cells[cellIndex];
        if (!cell) return s;
        cells[cellIndex] = { ...cell, drawings: [] };
        return { mosaicCells: cells };
      }),

      updateTicker: (t) => set((s) => ({ tickers: { ...s.tickers, [t.symbol]: t } })),
      setOrderbook: (ob) => set({ orderbook: ob }),
      applyOrderbookDelta: (symbol, askUpdates, bidUpdates, ts) => set((s) => {
        const cur = s.orderbook && s.orderbook.symbol === symbol ? s.orderbook : null;
        if (!cur) return s;
        const askMap = new Map(cur.asks.map((l) => [l.price, l.qty]));
        const bidMap = new Map(cur.bids.map((l) => [l.price, l.qty]));
        for (const [pStr, qStr] of askUpdates) {
          const p = parseFloat(pStr), q = parseFloat(qStr);
          if (q === 0) askMap.delete(p); else askMap.set(p, q);
        }
        for (const [pStr, qStr] of bidUpdates) {
          const p = parseFloat(pStr), q = parseFloat(qStr);
          if (q === 0) bidMap.delete(p); else bidMap.set(p, q);
        }
        const asks = sortLevels("asks", Array.from(askMap.entries()).map(([price, qty]) => ({ price, qty })));
        const bids = sortLevels("bids", Array.from(bidMap.entries()).map(([price, qty]) => ({ price, qty })));
        return { orderbook: { symbol, asks, bids, updatedAt: ts } };
      }),
      setCandles: (key, candles) => set((s) => ({ candles: { ...s.candles, [key]: candles } })),
      updateLastCandle: (key, c) => set((s) => {
        const existing = s.candles[key] ?? [];
        if (existing.length === 0) return { candles: { ...s.candles, [key]: [c] } };
        const last = existing[existing.length - 1];
        if (last.time === c.time) {
          const next = existing.slice(0, -1);
          next.push(c);
          return { candles: { ...s.candles, [key]: next } };
        }
        if (c.time > last.time) {
          const next = [...existing, c];
          if (next.length > 1000) next.shift();
          return { candles: { ...s.candles, [key]: next } };
        }
        return s;
      }),

      setConnected: (b) => set((s) => ({ connection: { ...s.connection, connected: b } })),
      setLatency: (ms) => set((s) => ({ connection: { ...s.connection, latencyMs: ms } })),

      pushJournal: (e) => set((s) => {
        const next = [...s.journal, e];
        if (next.length > 500) next.shift();
        return { journal: next };
      }),
      clearJournal: () => set({ journal: [] }),

      setPaperBalance: (v) => set({ paperBalance: v }),
      setPaperOrders: (o) => set({ paperOrders: o }),
      setPaperPositions: (p) => set({ paperPositions: p }),
      setPaperHistory: (h) => set({ paperHistory: h }),
      resetPaperAccount: () => set({
        paperBalance: 10000,
        paperOrders: [],
        paperPositions: [],
        paperHistory: [],
      }),
      upsertBot: (b) => set((s) => {
        const idx = s.botConfigs.findIndex((x) => x.id === b.id);
        const next = idx >= 0
          ? s.botConfigs.map((x, i) => (i === idx ? b : x))
          : [...s.botConfigs, b];
        return { botConfigs: next };
      }),
      removeBot: (id) => set((s) => ({ botConfigs: s.botConfigs.filter((b) => b.id !== id) })),

      setAllSymbols: (arr) => set({ allSymbols: arr }),

      updateSettings: (partial) => set((s) => ({ settings: mergeDeep(s.settings, partial) })),
      resetSettings: () => set({ settings: DEFAULT_SETTINGS }),

      setVenueMode: (mode) => set({ venueMode: mode }),

      openOrderPopup: (defaults, anchor) => set({
        orderPopup: { open: true, anchor: anchor ?? null, defaults },
      }),
      closeOrderPopup: () => set((s) => ({
        orderPopup: { ...s.orderPopup, open: false },
      })),
      setLastUsedQty: (qty) => set({ lastUsedQty: qty }),
      markFirstShiftClickToastShown: () => set({ firstShiftClickToastShown: true }),
    }),
    {
      name: "trading-app-store",
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedSlice => ({
        theme: state.theme,
        panels: state.panels,
        activeSymbol: state.activeSymbol,
        timeframe: state.timeframe,
        activeCellIndex: state.activeCellIndex,
        layout: state.layout,
        currentTool: state.currentTool,
        mosaicCells: state.mosaicCells,
        watchlist: state.watchlist,
        settings: state.settings,
        paperBalance: state.paperBalance,
        paperPositions: state.paperPositions,
        paperOrders: state.paperOrders,
        paperHistory: state.paperHistory,
        botConfigs: state.botConfigs,
        venueMode: state.venueMode,
        firstShiftClickToastShown: state.firstShiftClickToastShown,
        lastUsedQty: state.lastUsedQty,
      }),
      version: 1,
      // Default Zustand persist does a shallow merge — that drops any newly-added
      // settings keys because the persisted `settings` object overwrites the current
      // one wholesale. Deep-merge the `settings` slice so new fields fall back to
      // their defaults instead of becoming undefined and crashing the UI.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PersistedSlice>;
        const merged: Store = { ...current, ...p } as Store;
        if (p.settings) merged.settings = mergeDeep(current.settings, p.settings);
        return merged;
      },
    },
  ),
);

export type { Store };
