// Run description for the headless backtest runner: what to trade, over which
// slice of the local dataset, with which bot, and — the part that is deliberately
// not optional — which cost models apply.
//
// The engine already treats an undeclared cost model as "not applied" rather
// than "apply the default" (see BacktestVenueOptions). The config layer keeps
// that contract visible: `costs` is a required object, and `fees` and
// `slippage` must be spelled out inside it even when the answer is `false`.
// A run that pays nothing has to say so.

import type { BotConfig } from "../store";
import type { SlippageSettings } from "../settings";
import { getBotFactory } from "../bots/registry";
import { BYBIT_LINEAR_FEES, BYBIT_SPOT_FEES, type FeeSettings } from "../execution/fees";
import { DEFAULT_SLIPPAGE_CONTEXT, type SlippageContextSettings } from "../execution/slippage";
import { DEFAULT_REJECTION_SETTINGS, type RejectionSettings } from "../execution/rejection";
import { getInstrumentRules, type InstrumentRules } from "../execution/instrumentRules";
import type { FundingRateEvent } from "../execution/funding";
import type { MarginSettings } from "../execution/backtest/BacktestVenue";
import type { BacktestCosts } from "../execution/backtest/runner";
import { parseInterval, type DataInterval } from "../data/interval.ts";
import { normalizeSymbol, type Market } from "../data/paths.ts";
import { dayStartSec, isMonthKey, monthEndSec, monthStartSec } from "../data/months.ts";

/* ── declaration shapes (what a JSON file may contain) ────────────────────── */

export type FeesDecl = false | "bybit-linear" | "bybit-spot" | { makerRate: number; takerRate: number } | { flatRate: number };

export type SlippageDecl =
  | false
  | { kind: "fixed_bps"; bps: number }
  | { kind: "spread_pct"; spreadPct: number }
  | { kind: "volume_impact"; impactK: number; impactRefQty: number };

export type ToggleDecl<T> = boolean | Partial<T>;

export interface CostsDecl {
  fees: FeesDecl;
  slippage: SlippageDecl;
  slippageContext?: ToggleDecl<SlippageContextSettings>;
  rejection?: ToggleDecl<RejectionSettings>;
  rules?: boolean | InstrumentRules;
  funding?: boolean;
  margin?: ToggleDecl<MarginSettings>;
}

export interface RunDecl {
  name?: string;
  market?: Market;
  symbol?: string;
  interval?: string;
  from?: string | number;
  to?: string | number;
  initialBalance?: number;
  bot?: { kind?: string; id?: string; params?: Record<string, number | string> };
  costs?: CostsDecl;
  /** Multiplier for the "survives x2 slippage" acceptance check. null/absent = not checked. */
  stressSlippage?: number | null;
  /** Rolling-window shape for the "profitable months" criterion. */
  window?: { days?: number; stepDays?: number };
}

export interface RunFileDecl extends RunDecl {
  dataDir?: string;
  out?: string;
  /** Fields shared by every run in `runs`. */
  defaults?: RunDecl;
  runs?: RunDecl[];
}

/* ── resolved shapes (what the runner consumes) ───────────────────────────── */

export interface RunWindow {
  days: number;
  stepDays: number;
}

export interface RunSpec {
  name: string;
  market: Market;
  symbol: string;
  interval: DataInterval;
  /** Inclusive UTC-second bounds of the bars to feed the engine. */
  fromSec: number;
  toSec: number;
  initialBalance: number;
  bot: BotConfig;
  costs: CostsDecl;
  /** Flat fallback rate the venue uses when `costs.fees` is off. */
  feeRate: number;
  stressSlippage: number | null;
  window: RunWindow;
}

export interface RunPlan {
  name: string;
  dataDir?: string;
  out?: string;
  runs: RunSpec[];
}

export const DEFAULT_WINDOW: RunWindow = { days: 30, stepDays: 7 };
export const DEFAULT_INITIAL_BALANCE = 1000;

/**
 * What `"margin": true` means. The leverage cap is deliberately loose — its job
 * here is to stop a run from trading notional the account never had, not to
 * impose a risk policy. The maintenance rate matches Bybit's ~0.5% on small
 * BTCUSDT positions. Anything sharper belongs in the config, spelled out.
 */
export const DEFAULT_MARGIN: MarginSettings = { leverage: 10, maintenanceMarginRate: 0.005 };

/* ── time parsing ─────────────────────────────────────────────────────────── */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accepts `YYYY-MM`, `YYYY-MM-DD`, a full ISO timestamp, or raw epoch
 * seconds/milliseconds. `edge` decides which end of a bare month or day is
 * meant, so `{ from: "2026-04", to: "2026-04" }` covers all of April.
 */
export function parseRunTime(value: string | number | undefined, edge: "start" | "end", field: string): number {
  if (value === undefined || value === null || value === "") throw new Error(`${field} is required`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field}: not a finite timestamp`);
    return Math.floor(value > 1e11 ? value / 1000 : value);
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return parseRunTime(Number(raw), edge, field);
  if (isMonthKey(raw)) return edge === "start" ? monthStartSec(raw) : monthEndSec(raw) - 1;
  if (DAY_RE.test(raw)) {
    const start = dayStartSec(raw);
    return edge === "start" ? start : start + 86_400 - 1;
  }
  const ms = Date.parse(raw.includes("T") && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw}Z` : raw);
  if (!Number.isFinite(ms)) throw new Error(`${field}: cannot parse "${raw}" (use YYYY-MM, YYYY-MM-DD, ISO or epoch seconds)`);
  return Math.floor(ms / 1000);
}

/* ── declaration -> spec ──────────────────────────────────────────────────── */

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function mergeDecl(base: RunDecl | undefined, over: RunDecl): RunDecl {
  if (!base) return over;
  return {
    ...base,
    ...over,
    bot: over.bot || base.bot ? { ...base.bot, ...over.bot, params: { ...base.bot?.params, ...over.bot?.params } } : undefined,
    costs: (over.costs ?? base.costs) as CostsDecl | undefined,
    window: { ...base.window, ...over.window },
  };
}

function assertCostsDeclared(decl: RunDecl, where: string): CostsDecl {
  const costs = decl.costs;
  if (!costs || typeof costs !== "object") {
    fail(where, 'costs must be declared explicitly, e.g. {"fees":"bybit-linear","slippage":{"kind":"fixed_bps","bps":5}} or {"fees":false,"slippage":false}');
  }
  const missing = (["fees", "slippage"] as const).filter((k) => costs[k] === undefined);
  if (missing.length > 0) {
    fail(where, `costs.${missing.join(" and costs.")} must be stated explicitly (use false to declare "no model")`);
  }
  return costs;
}

export function resolveRunSpec(decl: RunDecl, where = "run"): RunSpec {
  const symbol = normalizeSymbol(decl.symbol ?? fail(where, "symbol is required"));
  const market = (decl.market ?? "linear") as Market;
  if (market !== "linear" && market !== "spot") fail(where, `market must be linear or spot, got "${market}"`);

  const interval = parseInterval(decl.interval ?? "1m");
  const fromSec = parseRunTime(decl.from, "start", `${where}.from`);
  const toSec = parseRunTime(decl.to, "end", `${where}.to`);
  if (toSec <= fromSec) fail(where, "to must be after from");

  const kind = decl.bot?.kind ?? fail(where, "bot.kind is required");
  const factory = getBotFactory(kind);
  if (!factory) fail(where, `unknown bot kind "${kind}"`);

  const initialBalance = decl.initialBalance ?? DEFAULT_INITIAL_BALANCE;
  if (!Number.isFinite(initialBalance) || initialBalance <= 0) fail(where, "initialBalance must be a positive number");

  const costs = assertCostsDeclared(decl, where);

  const stress = decl.stressSlippage ?? null;
  if (stress !== null && (!Number.isFinite(stress) || stress <= 0)) fail(where, "stressSlippage must be a positive number or null");

  const windowDays = decl.window?.days ?? DEFAULT_WINDOW.days;
  const stepDays = decl.window?.stepDays ?? DEFAULT_WINDOW.stepDays;
  if (!(windowDays > 0) || !(stepDays > 0)) fail(where, "window.days and window.stepDays must be positive");

  const bot: BotConfig = {
    id: decl.bot?.id ?? `cli-${kind}`,
    kind,
    symbol,
    params: { ...factory.defaultParams, ...decl.bot?.params },
    status: "stopped",
  };

  return {
    name: decl.name ?? `${kind}-${symbol}-${interval}`,
    market,
    symbol,
    interval,
    fromSec,
    toSec,
    initialBalance,
    bot,
    costs,
    feeRate: flatFeeRate(costs.fees),
    stressSlippage: stress,
    window: { days: windowDays, stepDays },
  };
}

/**
 * The venue always charges something: when `costs.fees` is off it falls back to
 * the flat `feeRate`. Declaring `fees:false` therefore has to mean zero, not
 * "whatever the default flat rate happens to be".
 */
function flatFeeRate(fees: FeesDecl): number {
  if (fees === false) return 0;
  if (typeof fees === "object" && fees !== null && "flatRate" in fees) return Math.max(0, Number(fees.flatRate) || 0);
  return 0;
}

export function parseRunPlan(input: unknown, source = "config"): RunPlan {
  if (!input || typeof input !== "object") fail(source, "config must be a JSON object");
  const file = input as RunFileDecl;
  const declared = Array.isArray(file.runs) ? file.runs : null;
  const list = declared ?? [stripFileFields(file)];
  if (list.length === 0) fail(source, "runs is empty");

  const seen = new Set<string>();
  const runs = list.map((run, i) => {
    const merged = declared ? mergeDecl(file.defaults, run) : run;
    const spec = resolveRunSpec(merged, `${source}.runs[${i}]`);
    let name = spec.name;
    for (let n = 2; seen.has(name); n++) name = `${spec.name}-${n}`;
    seen.add(name);
    return { ...spec, name };
  });

  return {
    name: file.name ?? "backtest",
    dataDir: file.dataDir,
    out: file.out,
    runs,
  };
}

function stripFileFields(file: RunFileDecl): RunDecl {
  const { dataDir: _d, out: _o, defaults: _def, runs: _r, ...rest } = file;
  return rest;
}

/* ── declaration -> engine cost models ────────────────────────────────────── */

export interface ResolvedCosts {
  costs: BacktestCosts;
  slippage: SlippageSettings;
  feeRate: number;
  /** One line per model, for the report. */
  description: string[];
}

const SLIPPAGE_BASE: SlippageSettings = {
  kind: "none",
  bps: 0,
  spreadPct: 0.5,
  impactK: 5,
  impactRefQty: 1,
};

export function resolveFees(decl: FeesDecl): FeeSettings | undefined {
  if (decl === false) return undefined;
  if (decl === "bybit-linear") return { ...BYBIT_LINEAR_FEES };
  if (decl === "bybit-spot") return { ...BYBIT_SPOT_FEES };
  if (decl && typeof decl === "object" && "flatRate" in decl) return undefined;
  if (decl && typeof decl === "object" && "makerRate" in decl && "takerRate" in decl) {
    return { makerRate: Number(decl.makerRate), takerRate: Number(decl.takerRate) };
  }
  throw new Error(`costs.fees: unsupported value ${JSON.stringify(decl)}`);
}

/**
 * Base slippage model. `stress` multiplies the magnitude of whichever model was
 * chosen — the acceptance rule asks whether the edge survives twice the
 * slippage, not twice some other knob.
 */
export function resolveSlippage(decl: SlippageDecl, stress = 1): SlippageSettings {
  const k = Number.isFinite(stress) && stress > 0 ? stress : 1;
  if (decl === false) return { ...SLIPPAGE_BASE };
  switch (decl?.kind) {
    case "fixed_bps":
      return { ...SLIPPAGE_BASE, kind: "fixed_bps", bps: Math.max(0, Number(decl.bps)) * k };
    case "spread_pct":
      return { ...SLIPPAGE_BASE, kind: "spread_pct", spreadPct: Math.min(1, Math.max(0, Number(decl.spreadPct)) * k) };
    case "volume_impact":
      return {
        ...SLIPPAGE_BASE,
        kind: "volume_impact",
        impactK: Math.max(0, Number(decl.impactK)) * k,
        impactRefQty: Math.max(1e-9, Number(decl.impactRefQty)),
      };
    default:
      throw new Error(`costs.slippage: unsupported value ${JSON.stringify(decl)}`);
  }
}

function toggle<T extends object>(decl: ToggleDecl<T> | undefined, defaults: T): T | undefined {
  if (decl === undefined || decl === false) return undefined;
  if (decl === true) return { ...defaults };
  return { ...defaults, ...decl };
}

/**
 * Turns a declaration plus the funding history read off disk into the exact
 * `BacktestCosts` the runner takes. Pure: the caller supplies the events.
 */
export function resolveCosts(
  spec: RunSpec,
  fundingEvents: readonly FundingRateEvent[] = [],
  opts: { stressSlippage?: number } = {},
): ResolvedCosts {
  const decl = spec.costs;
  const fees = resolveFees(decl.fees);
  const slippage = resolveSlippage(decl.slippage, opts.stressSlippage ?? 1);
  const slippageContext = toggle(decl.slippageContext, DEFAULT_SLIPPAGE_CONTEXT);
  const rejection = toggle(decl.rejection, { ...DEFAULT_REJECTION_SETTINGS, stressWindows: [] });
  const rules = decl.rules === undefined || decl.rules === false
    ? undefined
    : decl.rules === true
      ? getInstrumentRules(spec.symbol)
      : decl.rules;
  const funding = decl.funding ? { events: [...fundingEvents] } : undefined;
  const margin = toggle(decl.margin, DEFAULT_MARGIN);

  const costs: BacktestCosts = {};
  if (fees) costs.fees = fees;
  if (slippageContext) costs.slippageContext = slippageContext;
  if (rejection) costs.rejection = rejection;
  if (rules) costs.rules = rules;
  if (funding) costs.funding = funding;
  if (margin) costs.margin = margin;

  return { costs, slippage, feeRate: spec.feeRate, description: describeResolvedCosts(costs, slippage, spec.feeRate) };
}

function describeResolvedCosts(costs: BacktestCosts, slippage: SlippageSettings, feeRate: number): string[] {
  const out: string[] = [];
  out.push(costs.fees
    ? `fees: maker ${pct(costs.fees.makerRate)} / taker ${pct(costs.fees.takerRate)}`
    : `fees: flat ${pct(feeRate)} (no maker/taker split)`);
  out.push(`slippage: ${slippage.kind === "none" ? "off" : describeSlippageDecl(slippage)}`);
  out.push(`slippage context: ${costs.slippageContext ? `on, dead hours ${costs.slippageContext.deadHoursUtc.join(",")} x${costs.slippageContext.deadHourMultiplier}, weekend x${costs.slippageContext.weekendMultiplier}, cap x${costs.slippageContext.maxMultiplier}` : "off"}`);
  out.push(`rejection: ${costs.rejection ? `on, band ${costs.rejection.slippageToleranceBps} bps, limit touch fill ${(costs.rejection.limitFillProbability * 100).toFixed(0)}%` : "off"}`);
  out.push(`instrument rules: ${costs.rules ? `on, minQty ${costs.rules.minOrderQty}, step ${costs.rules.qtyStep}, tick ${costs.rules.tickSize}, minNotional ${costs.rules.minNotional}` : "off"}`);
  out.push(`funding: ${costs.funding ? `on, ${costs.funding.events.length} settlement(s) in range` : "off"}`);
  out.push(`margin: ${costs.margin ? `on, ${costs.margin.leverage}x cap, maintenance ${pct(costs.margin.maintenanceMarginRate)}` : "off — no leverage cap, no liquidation"}`);
  return out;
}

function describeSlippageDecl(s: SlippageSettings): string {
  switch (s.kind) {
    case "fixed_bps": return `${s.bps} bps`;
    case "spread_pct": return `${(s.spreadPct * 100).toFixed(0)}% of spread`;
    case "volume_impact": return `sqrt impact k=${s.impactK} ref=${s.impactRefQty}`;
    default: return "off";
  }
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
