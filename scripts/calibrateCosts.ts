import fs from "node:fs";
import path from "node:path";
import {
  dateRange,
  downloadBookDepth,
  forEachBookDepthRow,
  readBookDepthZip,
} from "../src/lib/data/bookDepthArchive.ts";
import {
  accumulateQuotes,
  accumulateTakerCost,
  accumulateVolatilityCost,
  addDepthRow,
  aggregateHours,
  aggregateTakerCost,
  createDepthProfile,
  createHourStats,
  createLimitFillStats,
  createTakerCostStats,
  createVolatilityCostStats,
  finishDepthProfile,
  meanDepth,
  rangeQuantile,
  simulateLimitFills,
  summarizeDepth,
  summarizeHours,
  summarizeLimitFills,
  summarizeTakerCost,
  summarizeDepthDays,
  summarizeVolatilityCost,
  type HourSummaryRow,
  type TakerCostRow,
} from "../src/lib/data/costCalibration.ts";
import { createRateLimiter, isNotFound } from "../src/lib/data/http.ts";
import { reportsDir, resolveDataRoot } from "../src/lib/data/paths.ts";
import {
  downloadTardisSample,
  firstOfMonthDates,
  readQuoteDay,
  readTradeDay,
  type TardisDataType,
} from "../src/lib/data/tardisSamples.ts";

/**
 * Measures the three numbers the cost model was guessing at.
 *
 *   npm run calibrate:costs -- --from 2024-09 --to 2026-08
 *
 * Downloads are cached under <data-dir>/orderbook and never refetched, so a
 * second run is pure computation. Nothing here touches the trading engine — it
 * writes a JSON report, and the defaults in src/lib/execution are edited by hand
 * from it so that every constant can be traced back to a printed measurement.
 */

const USAGE = `
Usage: npm run calibrate:costs -- --from 2024-09 --to 2026-08

  --from <YYYY-MM>       first month of Tardis samples (default: 2024-09)
  --to <YYYY-MM>         last month of Tardis samples (default: 2026-08)
  --symbol <ticker>      default: BTCUSDT
  --exchange <name>      Tardis exchange id (default: bybit)
  --tick <n>             tick size of the instrument (default: 0.1)
  --qty <n>              our order size in base units (default: 0.002 BTC)
  --latency <ms>         decision-to-arrival flight time (default: 250)
  --levels <n>           limit levels sampled per minute bar (default: 8)
  --depth-months <list>  full months of Binance bookDepth, e.g. 2025-01,2025-07
  --depth-days <list>    extra bookDepth days, e.g. 2025-10-09,2025-10-10
  --no-depth             skip the Binance bookDepth leg
  --offline              use only what is already cached
  --out <path>           report path (default: <data-dir>/reports/cost-calibration.json)
  --data-dir <path>      dataset root (default: ./data)
  --help
`.trim();

interface Args {
  from: string;
  to: string;
  symbol: string;
  exchange: string;
  tick: number;
  qty: number;
  latency: number;
  levels: number;
  depthMonths: string[];
  depthDays: string[];
  depth: boolean;
  offline: boolean;
  out?: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): Args {
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
  if (bare.has("help") || flags.has("help")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const numFlag = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      process.stderr.write(`bad --${name} "${raw}"\n`);
      process.exit(2);
    }
    return v;
  };
  return {
    from: flags.get("from") ?? "2024-09",
    to: flags.get("to") ?? "2026-08",
    symbol: (flags.get("symbol") ?? "BTCUSDT").toUpperCase(),
    exchange: flags.get("exchange") ?? "bybit",
    tick: numFlag("tick", 0.1),
    qty: numFlag("qty", 0.002),
    latency: Number(flags.get("latency") ?? 250),
    levels: numFlag("levels", 8),
    depthMonths: (flags.get("depth-months") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    depthDays: (flags.get("depth-days") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    depth: !bare.has("no-depth"),
    offline: bare.has("offline"),
    out: flags.get("out"),
    dataDir: flags.get("data-dir"),
  };
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function monthDays(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`bad month "${month}", expected YYYY-MM`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const nextY = mon === 12 ? year + 1 : year;
  const nextM = mon === 12 ? 1 : mon + 1;
  const last = new Date(Date.UTC(nextY, nextM - 1, 1) - 86_400_000);
  return dateRange(`${month}-01`, `${month}-${String(last.getUTCDate()).padStart(2, "0")}`);
}

interface Downloaded {
  bytes: number;
  files: number;
  cached: number;
  missing: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveDataRoot(args.dataDir);
  const dates = firstOfMonthDates(args.from, args.to);
  if (dates.length === 0) {
    process.stderr.write(`empty month range ${args.from}..${args.to}\n`);
    process.exit(2);
  }

  const limiter = createRateLimiter(2);
  const tardis: Downloaded = { bytes: 0, files: 0, cached: 0, missing: [] };

  async function ensure(dataType: TardisDataType, date: string): Promise<string | null> {
    const ref = { exchange: args.exchange, dataType, symbol: args.symbol, date };
    try {
      if (!args.offline) await limiter();
      const res = await downloadTardisSample(root, ref, { offline: args.offline });
      tardis.bytes += res.bytes;
      tardis.files++;
      if (res.fromCache) tardis.cached++;
      return res.file;
    } catch (err) {
      if (isNotFound(err)) {
        tardis.missing.push(`${dataType}/${date}`);
        return null;
      }
      throw err;
    }
  }

  const hourStats = createHourStats();
  const takerStats = createTakerCostStats([5, 10, 20, 50]);
  const takerStatsZeroLatency = createTakerCostStats([5, 10, 20, 50]);
  const fillStats = createLimitFillStats();
  const fillStatsBig = createLimitFillStats();
  const volStats = createVolatilityCostStats();
  const perDay: Array<{ date: string; quotes: number; trades: number; bars: number }> = [];

  for (const date of dates) {
    const quotesFile = await ensure("quotes", date);
    const tradesFile = await ensure("trades", date);
    if (!quotesFile || !tradesFile) {
      log(`${date}  skipped (sample not published)`);
      continue;
    }
    const q = readQuoteDay(quotesFile);
    const t = readTradeDay(tradesFile);
    const endMs = q.n > 0 ? q.ts[q.n - 1] : undefined;

    accumulateQuotes(q, hourStats, { tickSize: args.tick, endMs });
    accumulateTakerCost(q, takerStats, { latencyMs: args.latency });
    accumulateTakerCost(q, takerStatsZeroLatency, { latencyMs: 0 });

    const barsBefore = fillStats.bars;
    simulateLimitFills(q, t, fillStats, { ourQty: args.qty, tickSize: args.tick, levelsPerBar: args.levels });
    simulateLimitFills(q, t, fillStatsBig, { ourQty: args.qty * 10, tickSize: args.tick, levelsPerBar: args.levels });
    accumulateVolatilityCost(q, t, volStats, { latencyMs: args.latency });

    perDay.push({ date, quotes: q.n, trades: t.n, bars: fillStats.bars - barsBefore });
    log(
      `${date}  quotes ${q.n.toLocaleString("en-US")}  trades ${t.n.toLocaleString("en-US")}  bars ${
        fillStats.bars - barsBefore
      }`,
    );
  }

  /* ── binance bookDepth ─────────────────────────────────────────────────── */

  const depthProfile = createDepthProfile();
  const depth: Downloaded = { bytes: 0, files: 0, cached: 0, missing: [] };
  if (args.depth) {
    const depthDates = new Set<string>(dates);
    for (const m of args.depthMonths) for (const d of monthDays(m)) depthDates.add(d);
    for (const d of args.depthDays) depthDates.add(d);
    const sorted = [...depthDates].sort();
    for (const date of sorted) {
      try {
        if (!args.offline) await limiter();
        const res = await downloadBookDepth(root, { symbol: args.symbol, date }, { offline: args.offline });
        depth.bytes += res.bytes;
        depth.files++;
        if (res.fromCache) depth.cached++;
        const buf = readBookDepthZip(res.file);
        forEachBookDepthRow(buf, (row) => addDepthRow(depthProfile, row.timeSec, row.percentage, row.notional, date));
        depthProfile.days.add(date);
      } catch (err) {
        if (isNotFound(err)) {
          depth.missing.push(date);
          continue;
        }
        throw err;
      }
    }
    finishDepthProfile(depthProfile);
    log(`bookDepth: ${depth.files} days, ${mb(depth.bytes)}, ${depth.missing.length} missing`);
  }

  /* ── summaries ─────────────────────────────────────────────────────────── */

  const hourRows = summarizeHours(hourStats);
  const takerRows = summarizeTakerCost(takerStats);
  const takerRowsZero = summarizeTakerCost(takerStatsZeroLatency);
  const fillRows = summarizeLimitFills(fillStats);
  const fillRowsBig = summarizeLimitFills(fillStatsBig);
  const depthRows = summarizeDepth(depthProfile);
  const volRows = summarizeVolatilityCost(volStats, 0.2);

  const DEAD_HOURS = [3, 4, 5, 21, 22];
  const isDead = (h: number): boolean => DEAD_HOURS.includes(h);

  const spreadAll = aggregateHours(hourRows, () => true);
  const spreadDead = aggregateHours(hourRows, (r) => isDead(r.hour));
  const spreadLive = aggregateHours(hourRows, (r) => !isDead(r.hour));
  const spreadWeekday = aggregateHours(hourRows, (r) => !r.weekend);
  const spreadWeekend = aggregateHours(hourRows, (r) => r.weekend);

  const takerAll = aggregateTakerCost(takerRows, () => true);
  const takerDead = aggregateTakerCost(takerRows, (r) => isDead(r.hour));
  const takerLive = aggregateTakerCost(takerRows, (r) => !isDead(r.hour));
  const takerWeekday = aggregateTakerCost(takerRows, (r) => !r.weekend);
  const takerWeekend = aggregateTakerCost(takerRows, (r) => r.weekend);

  const report = {
    generatedAt: new Date().toISOString(),
    inputs: {
      exchange: args.exchange,
      symbol: args.symbol,
      months: `${args.from}..${args.to}`,
      sampleDays: perDay.length,
      tickSize: args.tick,
      ourQtyBase: args.qty,
      latencyMs: args.latency,
      levelsPerBar: args.levels,
      depthMonths: args.depthMonths,
      depthDays: args.depthDays,
    },
    downloads: {
      tardis: { files: tardis.files, bytes: tardis.bytes, cached: tardis.cached, missing: tardis.missing },
      binanceBookDepth: { files: depth.files, bytes: depth.bytes, cached: depth.cached, missing: depth.missing },
    },
    perDay,
    spreadByHour: hourRows,
    takerCostByHour: takerRows,
    takerCostByHourZeroLatency: takerRowsZero,
    depthByHour: depthRows,
    depthByDay: summarizeDepthDays(depthProfile),
    limitFillByPenetration: fillRows,
    limitFillByPenetrationTenX: fillRowsBig,
    costByBarRange: volRows,
    barRangePctQuantiles: {
      p50: rangeQuantile(volStats, 0.5),
      p90: rangeQuantile(volStats, 0.9),
      p99: rangeQuantile(volStats, 0.99),
    },
    limitFillTotals: {
      bars: fillStats.bars,
      levels: fillStats.levels,
      skippedLevels: fillStats.skippedLevels,
    },
    multipliers: {
      spread: {
        deadOverLive: spreadDead.meanSpreadBps / spreadLive.meanSpreadBps,
        deadOverAll: spreadDead.meanSpreadBps / spreadAll.meanSpreadBps,
        weekendOverWeekday: spreadWeekend.meanSpreadBps / spreadWeekday.meanSpreadBps,
      },
      takerCost: {
        deadOverLive: takerDead.meanBps / takerLive.meanBps,
        deadOverAll: takerDead.meanBps / takerAll.meanBps,
        weekendOverWeekday: takerWeekend.meanBps / takerWeekday.meanBps,
      },
      topOfBookNotional: {
        deadOverLive: spreadDead.meanTopNotional / spreadLive.meanTopNotional,
        weekendOverWeekday: spreadWeekend.meanTopNotional / spreadWeekday.meanTopNotional,
      },
      bookDepth1pct: {
        deadOverLive: meanDepth(depthRows, (r) => isDead(r.hour)) / meanDepth(depthRows, (r) => !isDead(r.hour)),
        weekendOverWeekday: meanDepth(depthRows, (r) => r.weekend) / meanDepth(depthRows, (r) => !r.weekend),
        days: depthProfile.days.size,
      },
    },
    aggregates: {
      spread: { all: spreadAll, dead: spreadDead, live: spreadLive, weekday: spreadWeekday, weekend: spreadWeekend },
      taker: { all: takerAll, dead: takerDead, live: takerLive, weekday: takerWeekday, weekend: takerWeekend },
      quoteTimeDroppedSec: hourStats.droppedSec,
      takerSamplesSkipped: takerStats.skipped,
    },
  };

  const outPath = args.out ?? path.join(reportsDir(root), "cost-calibration.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  printSummary(hourRows, takerRows, fillRows, volRows, volStats, report);
  log("");
  log(`tardis: ${tardis.files} files, ${mb(tardis.bytes)} (${tardis.cached} from cache)`);
  log(`report: ${outPath}`);
}

function printSummary(
  hourRows: HourSummaryRow[],
  takerRows: TakerCostRow[],
  fillRows: ReturnType<typeof summarizeLimitFills>,
  volRows: ReturnType<typeof summarizeVolatilityCost>,
  volStats: ReturnType<typeof createVolatilityCostStats>,
  report: Record<string, unknown>,
): void {
  log("");
  log("hour  spread bps  1-tick share  top notional USDT  taker bps  p99 bps");
  for (let h = 0; h < 24; h++) {
    const s = aggregateHours(hourRows, (r) => r.hour === h);
    const t = aggregateTakerCost(takerRows, (r) => r.hour === h);
    const p99 = takerRows.filter((r) => r.hour === h).sort((a, b) => b.samples - a.samples)[0]?.p99Bps ?? NaN;
    log(
      `${String(h).padStart(4)}  ${s.meanSpreadBps.toFixed(4).padStart(10)}  ` +
        `${(hourRows.filter((r) => r.hour === h).reduce((a, r) => a + r.oneTickShare * r.hours, 0) / Math.max(1e-9, s.hours)).toFixed(3).padStart(12)}  ` +
        `${Math.round(s.meanTopNotional).toLocaleString("en-US").padStart(17)}  ` +
        `${t.meanBps.toFixed(4).padStart(9)}  ${p99.toFixed(2).padStart(7)}`,
    );
  }
  log("");
  log("penetration bps   touches   swept   back-of-queue   uniform    front   queue ahead USDT");
  for (const r of fillRows) {
    const to = Number.isFinite(r.toBps) ? r.toBps.toFixed(3) : "inf";
    const label = r.toBps === 0 ? "exactly 0" : `${r.fromBps.toFixed(3)}..${to}`;
    log(
      `${label.padStart(15)}  ${r.touches.toLocaleString("en-US").padStart(8)}  ` +
        `${(r.sweptShare * 100).toFixed(1).padStart(5)}%  ` +
        `${(r.fillRate * 100).toFixed(1).padStart(6)}% [${(r.ci95[0] * 100).toFixed(1)},${(r.ci95[1] * 100).toFixed(1)}]  ` +
        `${(r.fillRateUniform * 100).toFixed(1).padStart(6)}%  ${(r.fillRateOptimistic * 100).toFixed(1).padStart(6)}%  ` +
        `${Math.round(r.meanQueueAheadNotional).toLocaleString("en-US").padStart(16)}`,
    );
  }
  log("");
  log("bar range %      bars   share   spread bps   taker bps   multiplier   top notional");
  for (const r of volRows) {
    const to = Number.isFinite(r.toPct) ? r.toPct.toFixed(2) : "inf";
    log(
      `${`${r.fromPct.toFixed(2)}..${to}`.padStart(12)}  ${r.bars.toLocaleString("en-US").padStart(8)}  ` +
        `${(r.barShare * 100).toFixed(1).padStart(5)}%  ${r.meanSpreadBps.toFixed(4).padStart(11)}  ` +
        `${r.meanCostBps.toFixed(4).padStart(10)}  ${r.multiplier.toFixed(2).padStart(11)}  ` +
        `${Math.round(r.meanTopNotional).toLocaleString("en-US").padStart(13)}`,
    );
  }
  log(`bar range pct: p50 <= ${rangeQuantile(volStats, 0.5)}, p90 <= ${rangeQuantile(volStats, 0.9)}, p99 <= ${rangeQuantile(volStats, 0.99)}`);

  log("");
  log(`multipliers: ${JSON.stringify((report as { multipliers: unknown }).multipliers, null, 2)}`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
