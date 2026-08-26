import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  downloadBookDepth,
  forEachBookDepthRow,
  readBookDepthZip,
} from "../src/lib/data/bookDepthArchive.ts";
import { isNotFound } from "../src/lib/data/http.ts";
import {
  accumulateBookSnapshots,
  createLiquidityStats,
  mergeLiquidityStats,
  summarizeLiquidity,
  type LiquiditySummary,
} from "../src/lib/data/liquidityProfile.ts";
import { reportsDir, resolveDataRoot } from "../src/lib/data/paths.ts";
import { downloadTardisSample, tardisCachePath } from "../src/lib/data/tardisSamples.ts";
import { CASCADE_UNIVERSE } from "../src/lib/data/universe.ts";

/**
 * Per-symbol execution cost for the whole cross-section universe.
 *
 *   npm run measure:liquidity -- --dates 2025-02-01,2025-08-01,2026-02-01,2026-08-01
 *
 * The positioning factor's headline — 27% a year after 5.5 bp a side — was
 * measured against a cost calibrated on BTCUSDT, where the spread is one tick
 * 99.8% of the time. Half the basket is TRB, COTI, ALICE, MASK, ZEN. This
 * script prices a market order of our size on every one of the forty-four, from
 * the real five-level book, and writes what it finds. Nothing is extrapolated:
 * a symbol with no sample is reported as missing.
 *
 * Two sources, both free:
 *  - Tardis `book_snapshot_5` for binance-futures, first of the month only, for
 *    spread and the cost of walking the visible book;
 *  - Binance `bookDepth`, any day, for the +-1% band — which is what says where
 *    a bigger deposit would start to matter, and which can cover crash days
 *    that the Tardis samples structurally cannot.
 */

const DEFAULT_DATES = ["2025-02-01", "2025-08-01", "2026-02-01", "2026-08-01"];
const DEFAULT_SIZES = [55, 110, 250, 550, 1100, 5500, 11000];
const DEFAULT_DEPTH_DAYS = [
  "2025-02-01",
  "2025-08-01",
  "2026-02-01",
  "2026-08-01",
  "2025-02-03",
  "2025-04-07",
  "2025-10-10",
  "2025-10-11",
];

const USAGE = `
Usage: npm run measure:liquidity -- --dates 2025-02-01,2026-08-01

  --symbols <list>     default: the frozen 44-symbol universe
  --dates <list>       first-of-month sample days (default: ${DEFAULT_DATES.join(",")})
  --sizes <list>       order notionals in USDT (default: ${DEFAULT_SIZES.join(",")})
  --exchange <name>    Tardis exchange id (default: binance-futures)
  --levels <5|25>      book_snapshot depth to read (default: 5; 25 is 4x the bytes)
  --max-gap <ms>       longer gaps between snapshots are a feed outage (default: 60000)
  --depth-days <list>  Binance bookDepth days (default: samples plus four crash days)
  --no-depth           skip the bookDepth leg
  --drop-cache         delete each book snapshot after reading it (saves ~4 GB)
  --offline            use only what is already cached
  --out <path>         default: <data-dir>/reports/liquidity
  --tag <name>         report basename (default: universe)
  --help
`.trim();

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
  return v;
}

function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function list(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "n/a";
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

interface DayNote {
  date: string;
  bytes: number;
  rows: number;
  bad: number;
  summary: LiquiditySummary;
}

interface DepthNote {
  date: string;
  /** Median across the day of the notional within +-1% of mid, both sides. */
  medianBand1Usdt: number;
  minBand1Usdt: number;
  snapshots: number;
}

interface SymbolReport {
  symbol: string;
  tier: string;
  volumeUsdt: number;
  minQty: number;
  qtyStep: number;
  minNotionalUsdt: number;
  days: DayNote[];
  missingDates: string[];
  combined: LiquiditySummary | null;
  depth: DepthNote[];
  depthMissing: string[];
}

async function measureDepthDay(
  root: string,
  symbol: string,
  date: string,
  offline: boolean,
): Promise<DepthNote | null> {
  try {
    const dl = await downloadBookDepth(root, { symbol, date }, { offline, retries: 2 });
    const buf = readBookDepthZip(dl.file);
    // bookDepth publishes one row per band per snapshot; sum the +-1% pair.
    const byTime = new Map<number, number>();
    forEachBookDepthRow(buf, (row) => {
      if (Math.abs(row.percentage) !== 1) return;
      byTime.set(row.timeSec, (byTime.get(row.timeSec) ?? 0) + row.notional);
    });
    const values = [...byTime.values()].sort((a, b) => a - b);
    if (values.length === 0) return null;
    return {
      date,
      medianBand1Usdt: values[Math.floor(values.length / 2)],
      minBand1Usdt: values[0],
      snapshots: values.length,
    };
  } catch (err) {
    if (isNotFound(err) || offline) return null;
    throw err;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (flag(argv, "help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const symbols = list(arg(argv, "symbols"), CASCADE_UNIVERSE.map((s) => s.symbol));
  const dates = list(arg(argv, "dates"), DEFAULT_DATES);
  const sizes = list(arg(argv, "sizes"), DEFAULT_SIZES.map(String)).map(Number);
  const exchange = arg(argv, "exchange") ?? "binance-futures";
  const levels = Number(arg(argv, "levels") ?? 5);
  if (levels !== 5 && levels !== 25) fail("--levels must be 5 or 25");
  const dataType = levels === 25 ? ("book_snapshot_25" as const) : ("book_snapshot_5" as const);
  const maxGapMs = Number(arg(argv, "max-gap") ?? 60_000);
  const depthDays = list(arg(argv, "depth-days"), DEFAULT_DEPTH_DAYS);
  const withDepth = !flag(argv, "no-depth");
  const dropCache = flag(argv, "drop-cache");
  const offline = flag(argv, "offline");
  const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "liquidity");
  const tag = arg(argv, "tag") ?? "universe";
  if (sizes.some((s) => !(s > 0))) fail("--sizes must be positive numbers");

  const started = Date.now();
  const reports: SymbolReport[] = [];
  let bytesTotal = 0;

  for (const spec of CASCADE_UNIVERSE.filter((s) => symbols.includes(s.symbol))) {
    const symbol = spec.symbol;
    const stats = createLiquidityStats({ sizes });
    const days: DayNote[] = [];
    const missing: string[] = [];

    for (const date of dates) {
      const ref = { exchange, dataType, symbol, date };
      let file: string;
      let bytes: number;
      try {
        const dl = await downloadTardisSample(dataRoot, ref, { offline, retries: 3, timeoutMs: 600_000 });
        file = dl.file;
        bytes = dl.bytes;
      } catch (err) {
        missing.push(date);
        process.stderr.write(`  ${symbol} ${date}: ${(err as Error).message.slice(0, 120)}\n`);
        continue;
      }
      bytesTotal += bytes;
      const dayStats = createLiquidityStats({ sizes });
      const raw = gunzipSync(fs.readFileSync(file));
      const endMs = Date.UTC(
        Number(date.slice(0, 4)),
        Number(date.slice(5, 7)) - 1,
        Number(date.slice(8, 10)) + 1,
      );
      const a = accumulateBookSnapshots(raw, dayStats, { fileLevels: levels, maxGapMs, endMs });
      mergeLiquidityStats(stats, dayStats);
      const daySummary = summarizeLiquidity(dayStats);
      days.push({ date, bytes, rows: a.rows, bad: a.bad, summary: daySummary });
      if (dropCache) fs.rmSync(tardisCachePath(dataRoot, ref), { force: true });
      const headIdx = sizes.indexOf(110) >= 0 ? sizes.indexOf(110) : 0;
      process.stderr.write(
        `  ${pad(symbol, 13)} ${date}  rows ${padLeft(String(a.rows), 9)}  ` +
          `spread ${padLeft(num(daySummary.spreadBpsMean, 2), 7)} bp  ` +
          `cost@${sizes[headIdx]} ${padLeft(num(daySummary.sizes[headIdx].costBpsMean, 2), 7)} bp\n`,
      );
    }

    const depth: DepthNote[] = [];
    const depthMissing: string[] = [];
    if (withDepth) {
      for (const date of depthDays) {
        const note = await measureDepthDay(dataRoot, symbol, date, offline);
        if (note) depth.push(note);
        else depthMissing.push(date);
      }
    }

    reports.push({
      symbol,
      tier: spec.tier,
      volumeUsdt: spec.volumeUsdt,
      minQty: spec.minQty,
      qtyStep: spec.qtyStep,
      minNotionalUsdt: spec.minNotionalUsdt,
      days,
      missingDates: missing,
      combined: days.length > 0 ? summarizeLiquidity(stats) : null,
      depth,
      depthMissing,
    });
  }

  /* ── report ─────────────────────────────────────────────────────────────── */

  const lines: string[] = [];
  lines.push("per-symbol liquidity and market-order cost");
  lines.push(
    `exchange ${exchange}  ${dataType}  sample days ${dates.join(",")}  ` +
      `sizes ${sizes.join("/")} USDT  max gap ${maxGapMs} ms`,
  );
  lines.push("");
  const headSize = sizes.indexOf(110) >= 0 ? sizes.indexOf(110) : 0;
  lines.push(
    `${pad("symbol", 14)}${padLeft("spread", 8)}${padLeft("med", 7)}${padLeft("p90", 7)}${padLeft("p99", 8)}` +
      `${padLeft("touch$", 10)}${padLeft(`${levels}lvl$`, 10)}` +
      sizes.map((s) => padLeft(`${s}`, 8)).join("") +
      `${padLeft("days", 6)}`,
  );
  for (const r of reports) {
    if (!r.combined) {
      lines.push(`${pad(r.symbol, 14)}  no sample on any requested date`);
      continue;
    }
    const c = r.combined;
    lines.push(
      pad(r.symbol, 14) +
        padLeft(num(c.spreadBpsMean, 2), 8) +
        padLeft(num(c.spreadBpsMedian, 2), 7) +
        padLeft(num(c.spreadBpsP90, 2), 7) +
        padLeft(num(c.spreadBpsP99, 2), 8) +
        padLeft(num(c.topUsdt, 0), 10) +
        padLeft(num(c.depthVisibleUsdt, 0), 10) +
        c.sizes.map((s) => padLeft(num(s.costBpsMean, 2), 8)).join("") +
        padLeft(String(r.days.length), 6),
    );
  }
  lines.push("");
  lines.push(`cost columns are the mean one-way cost of a market order of that many USDT, in bp against mid`);
  lines.push("");
  lines.push(
    `tail of the cost distribution at the headline size and how often ${levels} levels are not enough`,
  );
  lines.push(
    `${pad("symbol", 14)}${padLeft("size", 7)}${padLeft("mean", 8)}${padLeft("med", 8)}${padLeft("p90", 8)}` +
      `${padLeft("p99", 8)}${padLeft("max", 9)}${padLeft("unfilled", 10)}`,
  );
  for (const r of reports) {
    if (!r.combined) continue;
    const s = r.combined.sizes[headSize];
    lines.push(
      pad(r.symbol, 14) +
        padLeft(String(s.notionalUsdt), 7) +
        padLeft(num(s.costBpsMean, 2), 8) +
        padLeft(num(s.costBpsMedian, 2), 8) +
        padLeft(num(s.costBpsP90, 2), 8) +
        padLeft(num(s.costBpsP99, 2), 8) +
        padLeft(num(s.costBpsMax, 1), 9) +
        padLeft(num(s.unfilledFrac * 100, 3) + "%", 10),
    );
  }

  if (withDepth) {
    lines.push("");
    lines.push("Binance bookDepth: notional within +-1% of mid, both sides, USDT");
    lines.push(
      `${pad("symbol", 14)}${padLeft("median day", 13)}${padLeft("worst min", 12)}${padLeft("worst/med", 11)}  worst day`,
    );
    for (const r of reports) {
      if (r.depth.length === 0) {
        lines.push(`${pad(r.symbol, 14)}  no bookDepth on the requested days`);
        continue;
      }
      const meds = r.depth.map((d) => d.medianBand1Usdt).sort((a, b) => a - b);
      const median = meds[Math.floor(meds.length / 2)];
      let worst = r.depth[0];
      for (const d of r.depth) if (d.minBand1Usdt < worst.minBand1Usdt) worst = d;
      lines.push(
        pad(r.symbol, 14) +
          padLeft(num(median, 0), 13) +
          padLeft(num(worst.minBand1Usdt, 0), 12) +
          padLeft(num(worst.minBand1Usdt / median, 3), 11) +
          `  ${worst.date}`,
      );
    }
  }

  const missingAny = reports.filter((r) => r.missingDates.length > 0);
  if (missingAny.length > 0) {
    lines.push("");
    lines.push("sample days that do not exist and were not replaced by an estimate:");
    for (const r of missingAny) lines.push(`  ${pad(r.symbol, 14)} ${r.missingDates.join(",")}`);
  }

  lines.push("");
  lines.push(
    `downloaded ${(bytesTotal / 1e6).toFixed(0)} MB of book snapshots in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );

  const text = lines.join("\n");
  process.stdout.write(`${text}\n`);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, tag);
  fs.writeFileSync(`${base}.txt`, `${text}\n`, "utf8");
  fs.writeFileSync(
    `${base}.json`,
    JSON.stringify(
      { exchange, dataType, levels, dates, sizes, maxGapMs, depthDays, reports, elapsedMs: Date.now() - started },
      null,
      1,
    ),
    "utf8",
  );
  process.stderr.write(`\nwritten: ${base}.txt / .json\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
