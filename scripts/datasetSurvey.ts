import fs from "node:fs";
import path from "node:path";
import { aggregateBars } from "../src/lib/execution/backtest/aggregate.ts";
import { createCandleStore } from "../src/lib/data/candleStore.ts";
import { intervalSeconds, parseInterval, type DataInterval } from "../src/lib/data/interval.ts";
import { monthOf, toISO, type MonthKey } from "../src/lib/data/months.ts";
import { normalizeSymbol, reportsDir, resolveDataRoot, type DatasetKey, type Market } from "../src/lib/data/paths.ts";
import type { Candle } from "../src/lib/types.ts";

/**
 * Read-only walk over everything in `data/candles`, month by month, producing the
 * numbers that go into `docs/dataset.md`: per-year coverage, the holes, the
 * biggest single-bar moves, the longest zero-volume runs, and — where the same
 * symbol exists on both spot and the perpetual — how far apart the two daily
 * closes actually are.
 *
 * Streaming by month on purpose: nine years of minutes is 4.7M candle objects,
 * and holding a whole series just to count things costs half a gigabyte of heap.
 *
 * Usage: npm run data:survey [-- --top 12 --json]
 */

const USAGE = `
Usage: npm run data:survey -- [options]

  --data-dir <path>  dataset root (default: ./data, or $TRADING_DATA_DIR)
  --only <list>      comma-separated substrings; keeps datasets whose
                     market:symbol:interval label matches any of them
  --top <n>          how many extremes to list per dataset (default: 10)
  --json             also write the survey to <data-dir>/reports/dataset-survey.json
  --help
`.trim();

interface YearStat {
  year: number;
  bars: number;
  expected: number;
  zeroVolume: number;
  misaligned: number;
}

interface Gap {
  after: number;
  before: number;
  missing: number;
}

interface Extreme {
  time: number;
  pct: number;
  from: number;
  to: number;
}

interface FlatRun {
  from: number;
  to: number;
  bars: number;
}

interface Survey {
  key: DatasetKey;
  months: number;
  bars: number;
  bytes: number;
  firstTime: number | null;
  lastTime: number | null;
  sources: string[];
  duplicates: number;
  outOfOrder: number;
  misaligned: number;
  nonPositive: number;
  badOhlc: number;
  zeroVolume: number;
  gaps: Gap[];
  gapBars: number;
  extremes: Extreme[];
  flatRuns: FlatRun[];
  misalignedRuns: FlatRun[];
  years: YearStat[];
  daily: Candle[];
}

function parseArgs(argv: string[]): { dataDir?: string; only: string[]; top: number; json: boolean } {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      bare.add(name);
    }
  }
  if (bare.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const only = (flags.get("only") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { dataDir: flags.get("data-dir"), only, top: Number(flags.get("top") ?? 10), json: bare.has("json") };
}

/** Every (market, symbol, interval) triple that has at least one month on disk. */
function discover(root: string): DatasetKey[] {
  const base = path.join(root, "candles");
  const out: DatasetKey[] = [];
  for (const market of listDirs(base)) {
    if (market !== "linear" && market !== "spot") continue;
    for (const symbol of listDirs(path.join(base, market))) {
      for (const interval of listDirs(path.join(base, market, symbol))) {
        let parsed: DataInterval;
        try {
          parsed = parseInterval(interval);
        } catch {
          continue;
        }
        out.push({ market: market as Market, symbol: normalizeSymbol(symbol), interval: parsed });
      }
    }
  }
  return out.sort((a, b) => `${a.market}${a.symbol}${a.interval}`.localeCompare(`${b.market}${b.symbol}${b.interval}`));
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function yearOf(sec: number): number {
  return new Date(sec * 1000).getUTCFullYear();
}

function pushCapped<T>(list: T[], item: T, cap: number, worse: (a: T, b: T) => number): void {
  list.push(item);
  list.sort(worse);
  if (list.length > cap) list.length = cap;
}

function surveyDataset(root: string, key: DatasetKey, top: number): Survey {
  const store = createCandleStore(root);
  const step = intervalSeconds(key.interval);
  const months = store.listMonths(key);
  const stats = store.stats(key);

  const years = new Map<number, YearStat>();
  const gaps: Gap[] = [];
  const extremes: Extreme[] = [];
  const flatRuns: FlatRun[] = [];
  const misalignedRuns: FlatRun[] = [];
  const daily: Candle[] = [];

  let bars = 0;
  let gapBars = 0;
  let duplicates = 0;
  let outOfOrder = 0;
  let misaligned = 0;
  let nonPositive = 0;
  let badOhlc = 0;
  let zeroVolume = 0;

  let prev: Candle | null = null;
  let flatFrom: number | null = null;
  let flatLast = 0;
  let flatBars = 0;
  let offFrom: number | null = null;
  let offLast = 0;
  let offBars = 0;

  const bumpYear = (sec: number, zero: boolean, off: boolean): void => {
    const y = yearOf(sec);
    let stat = years.get(y);
    if (!stat) {
      stat = { year: y, bars: 0, expected: 0, zeroVolume: 0, misaligned: 0 };
      years.set(y, stat);
    }
    stat.bars++;
    if (zero) stat.zeroVolume++;
    if (off) stat.misaligned++;
  };

  for (const month of months) {
    const candles = store.readMonth(key, month);
    for (const c of candles) {
      bars++;
      const off = c.time % step !== 0;
      if (off) misaligned++;
      if (!(c.open > 0) || !(c.high > 0) || !(c.low > 0) || !(c.close > 0)) nonPositive++;
      if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) badOhlc++;

      const zero = !(c.volume > 0);
      if (zero) zeroVolume++;
      bumpYear(c.time, zero, off);

      if (off) {
        if (offFrom === null) {
          offFrom = c.time;
          offBars = 0;
        }
        offLast = c.time;
        offBars++;
      } else if (offFrom !== null) {
        pushCapped(misalignedRuns, { from: offFrom, to: offLast, bars: offBars }, top, (a, b) => b.bars - a.bars);
        offFrom = null;
      }

      if (zero) {
        if (flatFrom === null) {
          flatFrom = c.time;
          flatBars = 0;
        }
        flatLast = c.time;
        flatBars++;
      } else if (flatFrom !== null) {
        pushCapped(flatRuns, { from: flatFrom, to: flatLast, bars: flatBars }, top, (a, b) => b.bars - a.bars);
        flatFrom = null;
      }

      if (prev) {
        if (c.time === prev.time) duplicates++;
        else if (c.time < prev.time) outOfOrder++;
        else if (c.time > prev.time + step) {
          const missing = Math.round((c.time - prev.time) / step) - 1;
          gapBars += missing;
          pushCapped(gaps, { after: prev.time, before: c.time, missing }, top, (a, b) => b.missing - a.missing);
        } else if (prev.close > 0) {
          const pct = ((c.close - prev.close) / prev.close) * 100;
          pushCapped(
            extremes,
            { time: c.time, pct, from: prev.close, to: c.close },
            top,
            (a, b) => Math.abs(b.pct) - Math.abs(a.pct),
          );
        }
      }
      prev = c;
    }
    for (const d of aggregateBars(candles, 86400)) daily.push(d);
  }

  if (flatFrom !== null) pushCapped(flatRuns, { from: flatFrom, to: flatLast, bars: flatBars }, top, (a, b) => b.bars - a.bars);
  if (offFrom !== null) pushCapped(misalignedRuns, { from: offFrom, to: offLast, bars: offBars }, top, (a, b) => b.bars - a.bars);

  // Expected bars per year, clipped to the span actually held.
  if (stats.firstTime !== null && stats.lastTime !== null) {
    for (const stat of years.values()) {
      const yearStart = Math.floor(Date.UTC(stat.year, 0, 1) / 1000);
      const yearEnd = Math.floor(Date.UTC(stat.year + 1, 0, 1) / 1000) - step;
      const from = Math.max(yearStart, stats.firstTime);
      const to = Math.min(yearEnd, stats.lastTime);
      stat.expected = to >= from ? Math.floor((to - from) / step) + 1 : 0;
    }
  }

  return {
    key,
    months: months.length,
    bars,
    bytes: stats.bytes,
    firstTime: stats.firstTime,
    lastTime: stats.lastTime,
    sources: stats.sources,
    duplicates,
    outOfOrder,
    misaligned,
    nonPositive,
    badOhlc,
    zeroVolume,
    gaps,
    gapBars,
    extremes,
    flatRuns,
    misalignedRuns,
    years: Array.from(years.values()).sort((a, b) => a.year - b.year),
    daily,
  };
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(3)}%` : "-";
}

function humanBytes(bytes: number): string {
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatSurvey(s: Survey): string {
  const step = intervalSeconds(s.key.interval);
  const lines: string[] = [];
  lines.push(`\n=== ${s.key.market}:${s.key.symbol}:${s.key.interval} ===`);
  lines.push(
    `span      ${s.firstTime === null ? "-" : toISO(s.firstTime)} .. ${s.lastTime === null ? "-" : toISO(s.lastTime)}` +
      `   (${s.months} months, ${s.bars} bars, ${humanBytes(s.bytes)})`,
  );
  lines.push(`sources   ${s.sources.join("+") || "-"}`);
  lines.push(
    `defects   gaps ${s.gaps.length > 0 ? `${s.gapBars} bar(s)` : "0"}, dup ${s.duplicates}, out-of-order ${s.outOfOrder}, ` +
      `misaligned ${s.misaligned}, bad-ohlc ${s.badOhlc}, non-positive ${s.nonPositive}, ` +
      `zero-volume ${s.zeroVolume} (${pct(s.zeroVolume, s.bars)})`,
  );

  lines.push("\n  year    bars       expected   coverage   zero-vol  off-grid");
  for (const y of s.years) {
    lines.push(
      `  ${y.year}  ${String(y.bars).padStart(9)}  ${String(y.expected).padStart(9)}  ` +
        `${pct(y.bars, y.expected).padStart(9)}  ${String(y.zeroVolume).padStart(8)}  ${String(y.misaligned).padStart(8)}`,
    );
  }

  if (s.gaps.length > 0) {
    lines.push("\n  largest holes");
    for (const g of s.gaps) {
      lines.push(`    ${String(g.missing).padStart(7)} bar(s)  ${toISO(g.after)} -> ${toISO(g.before)}`);
    }
  }

  if (s.extremes.length > 0) {
    lines.push("\n  largest single-bar moves");
    for (const e of s.extremes) {
      lines.push(`    ${e.pct >= 0 ? "+" : ""}${e.pct.toFixed(2).padStart(6)}%  ${toISO(e.time)}  ${e.from} -> ${e.to}`);
    }
  }

  if (s.misalignedRuns.length > 0) {
    lines.push("\n  longest off-grid runs (open time not a multiple of the interval)");
    for (const f of s.misalignedRuns) {
      lines.push(`    ${String(f.bars).padStart(7)} bar(s)  ${toISO(f.from)} .. ${toISO(f.to)}  offset ${f.from % step}s`);
    }
  }

  if (s.flatRuns.length > 0) {
    lines.push("\n  longest zero-volume runs");
    for (const f of s.flatRuns) {
      lines.push(`    ${String(f.bars).padStart(7)} bar(s)  ${toISO(f.from)} .. ${toISO(f.to)}`);
    }
  }

  return lines.join("\n");
}

interface BasisStat {
  symbol: string;
  interval: string;
  days: number;
  from: string;
  to: string;
  medianAbsBps: number;
  p95AbsBps: number;
  maxAbsBps: number;
  maxAt: string;
  returnCorr: number;
  medianAbsReturnDiffBps: number;
}

/** How far the perpetual's daily close sits from spot, and whether daily returns differ at all. */
function compareSpotPerp(spot: Survey, perp: Survey): BasisStat | null {
  const bySpot = new Map<number, Candle>();
  for (const d of spot.daily) bySpot.set(d.time, d);

  const pairs: { time: number; spot: Candle; perp: Candle }[] = [];
  for (const d of perp.daily) {
    const s = bySpot.get(d.time);
    if (s && s.close > 0 && d.close > 0) pairs.push({ time: d.time, spot: s, perp: d });
  }
  if (pairs.length < 30) return null;

  const basis: { bps: number; time: number }[] = [];
  const spotRet: number[] = [];
  const perpRet: number[] = [];
  const retDiff: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    basis.push({ bps: ((p.perp.close - p.spot.close) / p.spot.close) * 10000, time: p.time });
    if (i > 0 && pairs[i - 1].time + 86400 === p.time) {
      const rs = Math.log(p.spot.close / pairs[i - 1].spot.close);
      const rp = Math.log(p.perp.close / pairs[i - 1].perp.close);
      spotRet.push(rs);
      perpRet.push(rp);
      retDiff.push(Math.abs(rp - rs) * 10000);
    }
  }

  const abs = basis.map((b) => Math.abs(b.bps)).sort((a, b) => a - b);
  const worst = basis.reduce((a, b) => (Math.abs(b.bps) > Math.abs(a.bps) ? b : a));
  const q = (arr: number[], p: number): number => (arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]);

  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(spotRet);
  const mp = mean(perpRet);
  let cov = 0;
  let vs = 0;
  let vp = 0;
  for (let i = 0; i < spotRet.length; i++) {
    cov += (spotRet[i] - ms) * (perpRet[i] - mp);
    vs += (spotRet[i] - ms) ** 2;
    vp += (perpRet[i] - mp) ** 2;
  }

  return {
    symbol: perp.key.symbol,
    interval: perp.key.interval,
    days: pairs.length,
    from: toISO(pairs[0].time),
    to: toISO(pairs[pairs.length - 1].time),
    medianAbsBps: q(abs, 0.5),
    p95AbsBps: q(abs, 0.95),
    maxAbsBps: Math.abs(worst.bps),
    maxAt: toISO(worst.time),
    returnCorr: vs > 0 && vp > 0 ? cov / Math.sqrt(vs * vp) : NaN,
    medianAbsReturnDiffBps: q(retDiff.slice().sort((a, b) => a - b), 0.5),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveDataRoot(args.dataDir);
  const all = discover(root);
  const keys =
    args.only.length === 0
      ? all
      : all.filter((k) => args.only.some((f) => `${k.market}:${k.symbol}:${k.interval}`.toLowerCase().includes(f)));
  if (keys.length === 0) {
    process.stderr.write(`no datasets under ${path.join(root, "candles")}\n`);
    process.exit(2);
  }

  process.stdout.write(`data root: ${root}\n`);
  const surveys: Survey[] = [];
  let totalBars = 0;
  let totalBytes = 0;
  for (const key of keys) {
    const s = surveyDataset(root, key, args.top);
    surveys.push(s);
    totalBars += s.bars;
    totalBytes += s.bytes;
    process.stdout.write(`${formatSurvey(s)}\n`);
  }

  process.stdout.write(`\n=== totals ===\n${keys.length} dataset(s), ${totalBars} bars, ${humanBytes(totalBytes)}\n`);

  const basis: BasisStat[] = [];
  for (const perp of surveys) {
    if (perp.key.market !== "linear") continue;
    const spot = surveys.find(
      (s) => s.key.market === "spot" && s.key.symbol === perp.key.symbol && s.key.interval === perp.key.interval,
    );
    if (!spot) continue;
    const stat = compareSpotPerp(spot, perp);
    if (stat) basis.push(stat);
  }

  if (basis.length > 0) {
    process.stdout.write("\n=== perpetual vs spot, daily closes ===\n");
    process.stdout.write("  symbol     days   overlap                    median|basis|  p95    max      max at       ret corr  median|dret|\n");
    for (const b of basis) {
      process.stdout.write(
        `  ${b.symbol.padEnd(9)} ${String(b.days).padStart(5)}  ${b.from.slice(0, 10)}..${b.to.slice(0, 10)}  ` +
          `${b.medianAbsBps.toFixed(1).padStart(11)}  ${b.p95AbsBps.toFixed(1).padStart(5)}  ${b.maxAbsBps.toFixed(1).padStart(6)}  ` +
          `${b.maxAt.slice(0, 10)}  ${b.returnCorr.toFixed(5).padStart(8)}  ${b.medianAbsReturnDiffBps.toFixed(1).padStart(11)}\n`,
      );
    }
    process.stdout.write("  (basis and dret in basis points)\n");
  }

  if (args.json) {
    const dir = reportsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "dataset-survey.json");
    const payload = {
      generatedAt: Math.floor(Date.now() / 1000),
      root,
      datasets: surveys.map(({ daily, ...rest }) => ({
        ...rest,
        firstMonth: rest.firstTime === null ? null : (monthOf(rest.firstTime) as MonthKey),
        lastMonth: rest.lastTime === null ? null : (monthOf(rest.lastTime) as MonthKey),
      })),
      basis,
    };
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`\nsurvey: ${file}\n`);
  }
}

main();
