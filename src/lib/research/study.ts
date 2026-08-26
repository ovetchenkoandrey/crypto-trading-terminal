import { createCandleStore } from "../data/candleStore.ts";
import { createFundingStore } from "../data/fundingStore.ts";
import { intervalSeconds, parseInterval, type DataInterval } from "../data/interval.ts";
import { normalizeSymbol, type Market } from "../data/paths.ts";
import { aggregateBars } from "../execution/backtest/aggregate.ts";
import type { Candle } from "../types.ts";
import {
  autocorrAt,
  autocorrProfile,
  ljungBox,
  reversalByMagnitude,
  signEdge,
  type AutocorrResult,
  type LjungBox,
  type MagnitudeBucket,
  type SignEdge,
} from "./autocorr.ts";
import { moments, winsorize, type Moments } from "./descriptive.ts";
import { directionForecast, type DirectionForecast } from "./forecast.ts";
import { fundingCarry, fundingWindowReturns, type CarryBucket, type FundingPoint, type WindowStat } from "./funding.ts";
import { groupProfile, hourSpecs, weekdaySpecs, type GroupStat } from "./groups.ts";
import { alignSeries, crossCorrelationProfile, type CrossCorrResult } from "./leadLag.ts";
import { moveProfile, type MoveProfile } from "./moveSize.ts";
import { adjustPValues, type Adjusted } from "./multipleTesting.ts";
import {
  contiguousBlocks,
  contiguousBlocksWhere,
  coverage,
  createPriceLookup,
  logReturns,
  utcDayOfMonth,
  utcHour,
  utcWeekday,
  type ReturnSeries,
} from "./series.ts";
import { tailReversal, type TailReversalRow } from "./tailReversal.ts";
import { varianceRatio } from "./varianceRatio.ts";
import {
  harForecast,
  realizedVol,
  regimeTransitions,
  volConditionalMeanAbs,
  type HarForecast,
  type RegimeAnalysis,
} from "./volatility.ts";

/**
 * The whole market study, assembled from the estimators in this directory.
 *
 * The order of operations is driven by memory more than anything else: a
 * two-year minute series is a million candle objects, so each symbol is loaded,
 * reduced to typed arrays, and released before the next one starts. Only the
 * minute return series survives the pass, because the cross-symbol lead-lag
 * needs both at once and a Float64Array of a million doubles is eight
 * megabytes, not four hundred.
 */

export const DEFAULT_HORIZONS: DataInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export interface StudyOptions {
  dataRoot: string;
  market: Market;
  symbols: string[];
  fromSec: number;
  toSec: number;
  horizons?: DataInterval[];
  /** Lags used for the direction forecast at every horizon. */
  forecastLags?: number;
  /** Share of each series used to fit the forecast; the rest scores it. */
  trainFraction?: number;
  onProgress?: (message: string) => void;
}

export interface VarianceRatioRow {
  q: number;
  vr: number;
  zHeteroskedastic: number;
  pHeteroskedastic: number;
  zHomoskedastic: number;
  ciLow: number;
  ciHigh: number;
}

export interface HorizonStudy {
  interval: DataInterval;
  intervalSec: number;
  bars: number;
  returns: number;
  gaps: number;
  blocks: number;
  moments: Moments;
  move: MoveProfile;
  autocorr: AutocorrResult[];
  /** Same lags on returns clipped to their 0.1% tails — an outlier sanity check. */
  autocorrWinsorized: AutocorrResult[];
  /** Naive "repeat the last bar's sign" rule at lag 1. */
  momentum: SignEdge;
  /** Payoff of fading the previous bar, by how large that bar was. */
  reversal: MagnitudeBucket[];
  varianceRatio: VarianceRatioRow[];
  ljungBoxReturns: LjungBox;
  ljungBoxAbs: LjungBox;
  forecast: DirectionForecast | null;
  /** Lag-1 autocorrelation on each half of the sample, for stability. */
  rhoFirstHalf: number;
  rhoSecondHalf: number;
}

export interface HourAux {
  hour: number;
  meanVolume: number;
  meanRangeBps: number;
  bars: number;
}

export interface SessionStructure {
  label: string;
  returns: number;
  rho1: number;
  z: number;
  p: number;
  /** Fading the top decile of moves inside this session, basis points. */
  topDecileReversalBps: number;
  topDecileT: number;
  topDecileTriggerBps: number;
}

export interface CalendarStudy {
  hourly: GroupStat[];
  /** Serial structure measured inside a session rather than across the day. */
  sessions: SessionStructure[];
  hourAux: HourAux[];
  weekday: GroupStat[];
  /** 03:00-06:00 UTC against the rest of the day. */
  deadHours: GroupStat;
  weekend: GroupStat;
  monthStart: GroupStat;
}

export interface VolatilityStudy {
  /** Autocorrelation of absolute returns — the clustering itself. */
  absAutocorr1m: AutocorrResult[];
  absAutocorr1h: AutocorrResult[];
  hourlyHar: HarForecast;
  dailyHar: HarForecast;
  hourlyRegimes: RegimeAnalysis;
  dailyRegimes: RegimeAnalysis;
  /** Mean next-day realized volatility by current-day tercile. */
  dailyConditional: number[];
  /** Out-of-sample direction R2 at the daily horizon, for comparison. */
  dailyDirectionR2: number;
}

export interface FundingStudy {
  events: number;
  intervalSec: number;
  meanRateBps: number;
  minRateBps: number;
  maxRateBps: number;
  windows: WindowStat[];
  carry: CarryBucket[];
}

export interface SymbolStudy {
  symbol: string;
  market: Market;
  fromSec: number;
  toSec: number;
  minuteBars: number;
  coverage: number;
  horizons: HorizonStudy[];
  /** Fading the largest minute moves, held for several minutes. */
  tail: TailReversalRow[];
  calendar: CalendarStudy;
  volatility: VolatilityStudy;
  funding: FundingStudy | null;
}

export interface StudyResult {
  generatedAt: string;
  fromSec: number;
  toSec: number;
  market: Market;
  symbols: SymbolStudy[];
  /** First symbol against second on aligned minutes, negative through positive lags. */
  leadLag: { a: string; b: string; rows: CrossCorrResult[] } | null;
  /** Every headline test in one family, with Bonferroni and BH attached. */
  adjusted: Adjusted[];
}

/** Lags worth estimating: fifty observations per lag is the floor used here. */
export function lagsFor(n: number): number[] {
  return [1, 2, 3, 5, 10, 20, 50, 100].filter((l) => l * 50 <= n);
}

export function qsFor(n: number): number[] {
  return [2, 4, 8, 16, 32, 64].filter((q) => q * 50 <= n);
}

function absBlock(b: Float64Array): Float64Array {
  const out = new Float64Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = Math.abs(b[i]);
  return out;
}

/**
 * Lag-1 autocorrelation on one half of the sample. Structure that shows up in
 * the first year and vanishes in the second is not structure, and this is the
 * cheapest possible check of that.
 */
export function halfRho(blocks: readonly Float64Array[], half: 0 | 1): number {
  let total = 0;
  for (const b of blocks) total += b.length;
  const cut = Math.floor(total / 2);
  const picked: Float64Array[] = [];
  let seen = 0;
  for (const b of blocks) {
    const start = seen;
    const end = seen + b.length;
    seen = end;
    const from = half === 0 ? start : Math.max(start, cut);
    const to = half === 0 ? Math.min(end, cut) : end;
    if (to - from >= 2) picked.push(b.subarray(from - start, to - start));
  }
  return picked.length === 0 ? Number.NaN : autocorrProfile(picked, [1])[0].rho;
}

export function studyHorizon(
  bars: readonly Candle[],
  interval: DataInterval,
  forecastLags: number,
  trainFraction: number,
): HorizonStudy {
  const intervalSec = intervalSeconds(interval);
  const series = logReturns(bars, intervalSec);
  const blocks = contiguousBlocks(series, 2);
  const n = series.value.length;

  const ranges = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) ranges[i] = bars[i].open > 0 ? (bars[i].high - bars[i].low) / bars[i].open : 0;

  const vrRows: VarianceRatioRow[] = qsFor(n).map((q) => {
    const r = varianceRatio(blocks, q);
    return {
      q,
      vr: r.vr,
      zHeteroskedastic: r.zHeteroskedastic,
      pHeteroskedastic: r.pHeteroskedastic,
      zHomoskedastic: r.zHomoskedastic,
      ciLow: r.ciLow,
      ciHigh: r.ciHigh,
    };
  });

  const lbLags = Math.min(10, Math.max(1, Math.floor(n / 100)));
  return {
    interval,
    intervalSec,
    bars: bars.length,
    returns: n,
    gaps: series.gaps,
    blocks: blocks.length,
    moments: moments(series.value),
    move: moveProfile({ label: interval, intervalSec, returns: series.value, ranges }),
    autocorr: autocorrProfile(blocks, lagsFor(n)),
    autocorrWinsorized: autocorrProfile(blocks.map((b) => winsorize(b, 0.001)), lagsFor(n)),
    momentum: signEdge(blocks, 1),
    reversal: reversalByMagnitude(blocks, 10, 1),
    varianceRatio: vrRows,
    ljungBoxReturns: ljungBox(blocks, lbLags),
    ljungBoxAbs: ljungBox(blocks.map(absBlock), lbLags),
    forecast: n > forecastLags * 200 ? directionForecast(blocks, forecastLags, trainFraction) : null,
    rhoFirstHalf: halfRho(blocks, 0),
    rhoSecondHalf: halfRho(blocks, 1),
  };
}

/** Mean volume and mean bar range per UTC hour, straight off the minute bars. */
export function hourAuxProfile(bars: readonly Candle[]): HourAux[] {
  const volume = new Float64Array(24);
  const range = new Float64Array(24);
  const count = new Int32Array(24);
  for (const bar of bars) {
    const h = utcHour(bar.time);
    volume[h] += bar.volume;
    range[h] += bar.open > 0 ? (bar.high - bar.low) / bar.open : 0;
    count[h]++;
  }
  return Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    meanVolume: count[h] > 0 ? volume[h] / count[h] : Number.NaN,
    meanRangeBps: count[h] > 0 ? (range[h] / count[h]) * 1e4 : Number.NaN,
    bars: count[h],
  }));
}

/**
 * The sessions the hypothesis log argues about: the dead hours the night
 * strategies traded, the US-hours peak, and the rest of the day as a control.
 */
export const SESSION_WINDOWS: { label: string; accept: (t: number) => boolean }[] = [
  { label: "03-06 UTC (dead hours)", accept: (t) => utcHour(t) >= 3 && utcHour(t) < 6 },
  { label: "13-17 UTC (US peak)", accept: (t) => utcHour(t) >= 13 && utcHour(t) < 17 },
  { label: "weekend", accept: (t) => utcWeekday(t) === 0 || utcWeekday(t) === 6 },
  { label: "whole sample", accept: () => true },
];

export function sessionStructure(minute: ReturnSeries, label: string, accept: (t: number) => boolean): SessionStructure {
  const blocks = contiguousBlocksWhere(minute, accept, 2);
  const rho = autocorrAt(blocks, 1);
  const top = reversalByMagnitude(blocks, 10, 1)[9];
  return {
    label,
    returns: rho.n,
    rho1: rho.rho,
    z: rho.z,
    p: rho.p,
    topDecileReversalBps: top.reversalBps,
    topDecileT: top.t,
    topDecileTriggerBps: top.meanTriggerBps,
  };
}

export function calendarStudy(minute: ReturnSeries, bars: readonly Candle[]): CalendarStudy {
  const n = minute.value.length;
  const hours = new Int32Array(n);
  const weekdays = new Int32Array(n);
  const dead = new Int32Array(n);
  const weekend = new Int32Array(n);
  const monthStart = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = minute.time[i];
    const h = utcHour(t);
    const d = utcWeekday(t);
    hours[i] = h;
    weekdays[i] = d;
    dead[i] = h >= 3 && h < 6 ? 1 : 0;
    weekend[i] = d === 0 || d === 6 ? 1 : 0;
    monthStart[i] = utcDayOfMonth(t) <= 3 ? 1 : 0;
  }
  return {
    hourly: groupProfile(hours, minute.value, hourSpecs()),
    sessions: SESSION_WINDOWS.map((w) => sessionStructure(minute, w.label, w.accept)),
    hourAux: hourAuxProfile(bars),
    weekday: groupProfile(weekdays, minute.value, weekdaySpecs()),
    deadHours: groupProfile(dead, minute.value, [{ key: 1, label: "03:00-06:00 UTC" }])[0],
    weekend: groupProfile(weekend, minute.value, [{ key: 1, label: "Sat+Sun UTC" }])[0],
    monthStart: groupProfile(monthStart, minute.value, [{ key: 1, label: "days 1-3 of month" }])[0],
  };
}

export function volatilityStudy(minute: ReturnSeries, hourly: ReturnSeries, daily: ReturnSeries): VolatilityStudy {
  const minuteBlocks = contiguousBlocks(minute, 2).map(absBlock);
  const hourBlocks = contiguousBlocks(hourly, 2).map(absBlock);
  // A minimum bar count per period keeps a half-empty day out of the volatility
  // series, where it would look like a calm one.
  const hourRv = realizedVol(minute, 3600, 30);
  const dayRv = realizedVol(minute, 86400, 720);

  const dailyBlocks = contiguousBlocks(daily, 2);
  const dailyForecast = dailyBlocks.length > 0 && daily.value.length > 100 ? directionForecast(dailyBlocks, 3, 0.7) : null;

  return {
    absAutocorr1m: autocorrProfile(minuteBlocks, [1, 5, 15, 60, 240, 1440]),
    absAutocorr1h: autocorrProfile(hourBlocks, [1, 2, 6, 24, 168]),
    hourlyHar: harForecast(hourRv.vol, [1, 6, 24], 0.7),
    dailyHar: harForecast(dayRv.vol, [1, 5, 22], 0.7),
    hourlyRegimes: regimeTransitions(hourRv.vol, 3),
    dailyRegimes: regimeTransitions(dayRv.vol, 3),
    dailyConditional: volConditionalMeanAbs(dayRv.vol, dayRv.vol, 3),
    dailyDirectionR2: dailyForecast ? dailyForecast.outOfSampleR2 : Number.NaN,
  };
}

function fundingStudy(
  root: string,
  market: Market,
  symbol: string,
  fromSec: number,
  toSec: number,
  bars: readonly Candle[],
): FundingStudy | null {
  const store = createFundingStore(root);
  const events = store.readRange(market, symbol, fromSec, toSec);
  if (events.length < 20) return null;

  const months = store.listMonths(market, symbol);
  const file = months.length > 0 ? store.readMonthFile(market, symbol, months[0]) : null;
  const intervalSec = (file?.intervalMinutes ?? 480) * 60;

  const points: FundingPoint[] = events.map((e) => ({ time: e.time, rate: e.rate }));
  const at = createPriceLookup(bars);
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    sum += p.rate;
    if (p.rate < min) min = p.rate;
    if (p.rate > max) max = p.rate;
  }

  return {
    events: points.length,
    intervalSec,
    meanRateBps: (sum / points.length) * 1e4,
    minRateBps: min * 1e4,
    maxRateBps: max * 1e4,
    windows: fundingWindowReturns(points, at, [
      { label: "-60..-30 min", fromMin: -60, toMin: -30 },
      { label: "-30..-5 min", fromMin: -30, toMin: -5 },
      { label: "-5..0 min", fromMin: -5, toMin: 0 },
      { label: "0..+5 min", fromMin: 0, toMin: 5 },
      { label: "+5..+30 min", fromMin: 5, toMin: 30 },
      { label: "+30..+60 min", fromMin: 30, toMin: 60 },
    ]),
    carry: fundingCarry(points, at, intervalSec, 5),
  };
}

/**
 * The family every p-value in the report belongs to. Assembling it here rather
 * than eyeballing the tables is the whole point: across a few hundred slices,
 * "p below 0.05 somewhere" is not evidence of anything.
 */
export function collectTests(symbols: readonly SymbolStudy[], leadLag: StudyResult["leadLag"]): { label: string; p: number }[] {
  const out: { label: string; p: number }[] = [];
  for (const s of symbols) {
    for (const h of s.horizons) {
      for (const a of h.autocorr) out.push({ label: `${s.symbol} ${h.interval} rho(${a.lag})`, p: a.p });
      for (const a of h.autocorrWinsorized) out.push({ label: `${s.symbol} ${h.interval} rho_w(${a.lag})`, p: a.p });
      for (const v of h.varianceRatio) out.push({ label: `${s.symbol} ${h.interval} VR(${v.q})`, p: v.pHeteroskedastic });
      out.push({ label: `${s.symbol} ${h.interval} momentum edge`, p: h.momentum.p });
      for (const r of h.reversal) out.push({ label: `${s.symbol} ${h.interval} fade ${r.label}`, p: r.p });
      if (h.forecast) out.push({ label: `${s.symbol} ${h.interval} forecast edge`, p: h.forecast.testEdgeP });
    }
    for (const g of s.calendar.hourly) out.push({ label: `${s.symbol} hour ${g.label} mean`, p: g.p });
    for (const x of s.calendar.sessions) out.push({ label: `${s.symbol} ${x.label} rho(1)`, p: x.p });
    for (const r of s.tail) {
      out.push({ label: `${s.symbol} tail p${r.percentile} h${r.horizon}`, p: r.p });
    }
    for (const g of s.calendar.weekday) out.push({ label: `${s.symbol} ${g.label} mean`, p: g.p });
    out.push({ label: `${s.symbol} dead hours mean`, p: s.calendar.deadHours.p });
    out.push({ label: `${s.symbol} weekend mean`, p: s.calendar.weekend.p });
    out.push({ label: `${s.symbol} month start mean`, p: s.calendar.monthStart.p });
    if (s.funding) for (const w of s.funding.windows) out.push({ label: `${s.symbol} funding ${w.label}`, p: w.p });
  }
  if (leadLag) for (const r of leadLag.rows) out.push({ label: `${leadLag.a}->${leadLag.b} lag ${r.lag}`, p: r.p });
  return out;
}

export function runStudy(opts: StudyOptions): StudyResult {
  const horizons = opts.horizons ?? DEFAULT_HORIZONS;
  const forecastLags = opts.forecastLags ?? 5;
  const trainFraction = opts.trainFraction ?? 0.7;
  const say = opts.onProgress ?? (() => {});
  const store = createCandleStore(opts.dataRoot);

  const symbols: SymbolStudy[] = [];
  const minuteSeries = new Map<string, ReturnSeries>();

  for (const raw of opts.symbols) {
    const symbol = normalizeSymbol(raw);
    say(`${symbol}: loading minutes`);
    const bars = store.readRange({ market: opts.market, symbol, interval: parseInterval("1m") }, opts.fromSec, opts.toSec);
    if (bars.length === 0) throw new Error(`no candles for ${symbol} in the requested range`);

    const minute = logReturns(bars, 60);
    minuteSeries.set(symbol, minute);

    const horizonStudies: HorizonStudy[] = [];
    let hourly: ReturnSeries | null = null;
    let daily: ReturnSeries | null = null;
    for (const interval of horizons) {
      say(`${symbol}: ${interval}`);
      const sec = intervalSeconds(interval);
      const series = sec === 60 ? bars : aggregateBars(bars, sec);
      horizonStudies.push(studyHorizon(series, interval, forecastLags, trainFraction));
      if (sec === 3600) hourly = logReturns(series, 3600);
      if (sec === 86400) daily = logReturns(series, 86400);
    }

    say(`${symbol}: calendar`);
    const calendar = calendarStudy(minute, bars);

    say(`${symbol}: volatility`);
    const volatility = volatilityStudy(
      minute,
      hourly ?? logReturns(aggregateBars(bars, 3600), 3600),
      daily ?? logReturns(aggregateBars(bars, 86400), 86400),
    );

    say(`${symbol}: funding`);
    const funding = fundingStudy(opts.dataRoot, opts.market, symbol, opts.fromSec, opts.toSec, bars);

    symbols.push({
      symbol,
      market: opts.market,
      fromSec: bars[0].time,
      toSec: bars[bars.length - 1].time,
      minuteBars: bars.length,
      coverage: coverage(bars, 60),
      horizons: horizonStudies,
      tail: tailReversal(minute),
      calendar,
      volatility,
      funding,
    });
  }

  let leadLag: StudyResult["leadLag"] = null;
  if (symbols.length >= 2) {
    say("cross-symbol lead-lag");
    const a = symbols[0].symbol;
    const b = symbols[1].symbol;
    const pair = alignSeries(minuteSeries.get(a)!, minuteSeries.get(b)!);
    leadLag = { a, b, rows: crossCorrelationProfile(pair, [-5, -3, -2, -1, 0, 1, 2, 3, 5]) };
  }

  return {
    generatedAt: new Date().toISOString(),
    fromSec: opts.fromSec,
    toSec: opts.toSec,
    market: opts.market,
    symbols,
    leadLag,
    adjusted: adjustPValues(collectTests(symbols, leadLag)),
  };
}
