// Tester slice — kept in a separate Zustand store to keep the main one focused.
// Volatile only (running state) + per-session results. Persist only the last form
// params so the user doesn't retype them every time.

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

interface PersistedSlice {
  lastParams: TesterFormParams | null;
}

interface VolatileSlice {
  state: TesterState;
  run:   TesterRunInfo;
  cancelRequested: boolean;
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
}

type Store = PersistedSlice & VolatileSlice & Actions;

const DEFAULT_VOLATILE: VolatileSlice = {
  state: "idle",
  run: {
    startedAt: 0, finishedAt: null,
    loadProgress: null, runProgress: null,
    result: null, error: null,
  },
  cancelRequested: false,
};

export const useTesterStore = create<Store>()(
  persist(
    (set) => ({
      lastParams: null,
      ...DEFAULT_VOLATILE,

      setLastParams: (p) => set({ lastParams: p }),
      beginLoading: () => set({
        state: "loading",
        run: { startedAt: Date.now(), finishedAt: null, loadProgress: null, runProgress: null, result: null, error: null },
        cancelRequested: false,
      }),
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
      finish: (result) => set((s) => ({
        state: "done",
        run: { ...s.run, result, finishedAt: Date.now() },
      })),
      fail: (msg) => set((s) => ({
        state: "error",
        run: { ...s.run, error: msg, finishedAt: Date.now() },
      })),
      requestCancel: () => set({ cancelRequested: true }),
      reset: () => set(DEFAULT_VOLATILE),
    }),
    {
      name: "trading-app-tester",
      storage: createJSONStorage(() => localStorage),
      partialize: (s): PersistedSlice => ({ lastParams: s.lastParams }),
      version: 1,
    },
  ),
);
