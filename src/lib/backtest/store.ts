// Tester slice — kept in a separate Zustand store to keep the main one focused.
// Volatile only (running state) + per-session results. Persist only the last form
// params so the user doesn't retype them every time.
//
// The `view` slice is what the visual tester reads: which mosaic cell plays the
// run, which trade is selected, which layers are on, where the replay cursor is.
// It is deliberately volatile — a result lives until reload, so pinning view
// state to a result that no longer exists would only produce ghosts.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Interval } from "../types";
import type { BacktestResult, BacktestProgress } from "../execution/backtest/runner";

export type TesterState  = "idle" | "loading" | "running" | "done" | "error";
export type TesterMode   = "background" | "visual";
export type TesterSpeed  = 1 | 10 | 50 | 0;     // 0 = max (no throttling)

export interface TesterFormParams {
  botId:           string;       // refers to a BotConfig from main store
  symbol:          string;
  interval:        Interval;
  rangePreset:     "7d" | "30d" | "90d" | "365d" | "custom";
  fromSec:         number;       // UTC seconds — only used when rangePreset = "custom"
  toSec:           number;
  initialBalance:  number;
  mode:            TesterMode;
  speed:           TesterSpeed;  // visual mode only
}

export interface TesterRunInfo {
  startedAt:  number;            // UTC ms
  finishedAt: number | null;
  loadProgress: { loaded: number; estimated: number } | null;
  runProgress:  BacktestProgress | null;
  result:       BacktestResult  | null;
  error:        string | null;
}

/* ── visual tester view state ─────────────────────────────────────────────── */

export type TradeFilter  = "all" | "wins" | "losses";
export type TradeSortKey = "index" | "entryTs" | "ts" | "side" | "qty" | "entryPrice" | "exitPrice" | "pnl" | "hold";
export type SortDir      = "asc" | "desc";

/** Optional drawing layers over the backtest chart. */
export interface TesterLayers {
  /** Entry→exit segments — the main element. */
  segments:   boolean;
  /** Entry / exit triangles on the bars. */
  markers:    boolean;
  /** Price levels of pending / cancelled orders that never filled. */
  rejected:   boolean;
  /** Equity strip under the price chart, time-synced. */
  equity:     boolean;
}

export interface TesterReplay {
  /** Replay owns the visible bar count while active. */
  active:  boolean;
  playing: boolean;
  /** Index into the *display* candle series. */
  bar:     number;
  speed:   TesterSpeed;
}

export interface TesterViewState {
  /** Backtest result is rendered in a mosaic cell instead of the live chart. */
  onChart:   boolean;
  chartCell: number;
  /** Display timeframe in seconds; null = auto (pick by bar budget). */
  displayTfSec: number | null;
  selectedTradeId: string | null;
  /** Bumped whenever the chart should re-centre on the selected trade. */
  focusNonce: number;
  /** Bumped whenever the trades table should scroll the selected row into view. */
  revealNonce: number;
  /** Crosshair time shared between the price chart and the equity strip. */
  hoverTimeSec: number | null;
  filter:  TradeFilter;
  sortKey: TradeSortKey;
  sortDir: SortDir;
  layers:  TesterLayers;
  replay:  TesterReplay;
}

interface PersistedSlice {
  lastParams: TesterFormParams | null;
}

interface VolatileSlice {
  state: TesterState;
  run:   TesterRunInfo;
  cancelRequested: boolean;
  view:  TesterViewState;
}

interface Actions {
  setLastParams: (p: TesterFormParams) => void;
  beginLoading:  () => void;
  setLoadProgress: (loaded: number, estimated: number) => void;
  beginRun:      () => void;
  setRunProgress: (p: BacktestProgress) => void;
  finish:        (result: BacktestResult) => void;
  fail:          (msg: string) => void;
  requestCancel: () => void;
  reset:         () => void;

  // view
  showOnChart:   (cell?: number) => void;
  hideChart:     () => void;
  selectTrade:   (id: string | null, opts?: { focus?: boolean; reveal?: boolean }) => void;
  setFilter:     (f: TradeFilter) => void;
  toggleSort:    (key: TradeSortKey) => void;
  toggleLayer:   (key: keyof TesterLayers) => void;
  setDisplayTf:  (sec: number | null) => void;
  setHoverTime:  (sec: number | null) => void;
  replaySetActive: (active: boolean) => void;
  replaySetPlaying: (playing: boolean) => void;
  replaySetBar:  (bar: number) => void;
  replaySetSpeed: (speed: TesterSpeed) => void;
}

type Store = PersistedSlice & VolatileSlice & Actions;

const DEFAULT_VIEW: TesterViewState = {
  onChart: false,
  chartCell: 0,
  displayTfSec: null,
  selectedTradeId: null,
  focusNonce: 0,
  revealNonce: 0,
  hoverTimeSec: null,
  filter: "all",
  sortKey: "index",
  sortDir: "asc",
  layers: { segments: true, markers: true, rejected: false, equity: true },
  replay: { active: false, playing: false, bar: 0, speed: 50 },
};

const DEFAULT_VOLATILE: VolatileSlice = {
  state: "idle",
  run: {
    startedAt: 0, finishedAt: null,
    loadProgress: null, runProgress: null,
    result: null, error: null,
  },
  cancelRequested: false,
  view: DEFAULT_VIEW,
};

export const useTesterStore = create<Store>()(
  persist(
    (set) => ({
      lastParams: null,
      ...DEFAULT_VOLATILE,

      setLastParams: (p) => set({ lastParams: p }),
      beginLoading: () => set((s) => ({
        state: "loading",
        run: { startedAt: Date.now(), finishedAt: null, loadProgress: null, runProgress: null, result: null, error: null },
        cancelRequested: false,
        view: {
          ...s.view,
          selectedTradeId: null,
          displayTfSec: null,
          replay: { ...s.view.replay, active: false, playing: false, bar: 0 },
        },
      })),
      setLoadProgress: (loaded, estimated) => set((s) => ({
        run: { ...s.run, loadProgress: { loaded, estimated } },
      })),
      beginRun: () => set((s) => ({
        state: "running",
        run: { ...s.run, loadProgress: null },
      })),
      setRunProgress: (p) => set((s) => ({
        run: { ...s.run, runProgress: p },
      })),
      // A finished run takes over a chart cell straight away: the whole point of
      // the visual tester is that you see the trades without asking for them.
      finish: (result) => set((s) => ({
        state: "done",
        run: { ...s.run, result, finishedAt: Date.now() },
        view: { ...s.view, onChart: true, selectedTradeId: null },
      })),
      fail: (msg) => set((s) => ({
        state: "error",
        run: { ...s.run, error: msg, finishedAt: Date.now() },
      })),
      requestCancel: () => set({ cancelRequested: true }),
      reset: () => set((s) => ({
        ...DEFAULT_VOLATILE,
        view: { ...DEFAULT_VIEW, chartCell: s.view.chartCell },
      })),

      showOnChart: (cell) => set((s) => ({
        view: { ...s.view, onChart: true, chartCell: cell ?? s.view.chartCell },
      })),
      hideChart: () => set((s) => ({
        view: { ...s.view, onChart: false, replay: { ...s.view.replay, playing: false } },
      })),
      selectTrade: (id, opts) => set((s) => ({
        view: {
          ...s.view,
          selectedTradeId: id,
          focusNonce:  s.view.focusNonce  + (opts?.focus  ? 1 : 0),
          revealNonce: s.view.revealNonce + (opts?.reveal ? 1 : 0),
        },
      })),
      setFilter: (f) => set((s) => ({ view: { ...s.view, filter: f } })),
      toggleSort: (key) => set((s) => ({
        view: {
          ...s.view,
          sortKey: key,
          sortDir: s.view.sortKey === key && s.view.sortDir === "asc" ? "desc" : "asc",
        },
      })),
      toggleLayer: (key) => set((s) => ({
        view: { ...s.view, layers: { ...s.view.layers, [key]: !s.view.layers[key] } },
      })),
      setDisplayTf: (sec) => set((s) => ({
        // Bar indices are timeframe-relative — a replay cursor from another
        // timeframe would point at an unrelated date.
        view: { ...s.view, displayTfSec: sec, replay: { ...s.view.replay, bar: 0 } },
      })),
      setHoverTime: (sec) => set((s) => (
        s.view.hoverTimeSec === sec ? s : { view: { ...s.view, hoverTimeSec: sec } }
      )),
      replaySetActive: (active) => set((s) => ({
        view: { ...s.view, replay: { ...s.view.replay, active, playing: false, bar: active ? s.view.replay.bar : 0 } },
      })),
      replaySetPlaying: (playing) => set((s) => ({
        view: { ...s.view, replay: { ...s.view.replay, playing, active: playing ? true : s.view.replay.active } },
      })),
      replaySetBar: (bar) => set((s) => ({
        view: { ...s.view, replay: { ...s.view.replay, bar: Math.max(0, Math.floor(bar)) } },
      })),
      replaySetSpeed: (speed) => set((s) => ({
        view: { ...s.view, replay: { ...s.view.replay, speed } },
      })),
    }),
    {
      name: "trading-app-tester",
      storage: createJSONStorage(() => localStorage),
      partialize: (s): PersistedSlice => ({ lastParams: s.lastParams }),
      version: 1,
    },
  ),
);
