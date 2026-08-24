import path from "node:path";
import { createCandleStore } from "../src/lib/data/candleStore.ts";
import { createFundingStore } from "../src/lib/data/fundingStore.ts";
import { buildQualityReport, writeReportFiles } from "../src/lib/data/datasetReport.ts";
import { fetchDataset, fetchFundingDataset, type ProgressEvent } from "../src/lib/data/fetchDataset.ts";
import { parseInterval, type DataInterval } from "../src/lib/data/interval.ts";
import { isMonthKey, monthEndSec, monthOf, monthStartSec, type MonthKey } from "../src/lib/data/months.ts";
import { normalizeSymbol, reportsDir, resolveDataRoot, type DatasetKey, type Market } from "../src/lib/data/paths.ts";
import { formatFundingReport, formatQualityReport, validateFunding } from "../src/lib/data/validate.ts";

const USAGE = `
Usage: npm run data:fetch -- --symbol BTCUSDT --from 2024-09 --to 2026-08 --interval 1m

  --symbol <list>     comma-separated symbols (required)
  --from <YYYY-MM>    first month, inclusive (required)
  --to <YYYY-MM>      last month, inclusive (default: current month)
  --interval <tf>     1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d, or Bybit/MT notation (default: 1m)
  --market <name>     linear | spot (default: linear)
  --data-dir <path>   dataset root (default: ./data, or $TRADING_DATA_DIR)
  --report <path>     report output directory (default: <data-dir>/reports)

  --funding           also fetch funding history for the same range
  --funding-only      skip candles
  --no-tail           archives only, do not follow the tail via Bybit REST
  --no-daily          skip daily archives, use REST for anything not packaged monthly
  --force             refetch months already marked complete
  --validate-only     no network, just re-run the checks over what is on disk
  --allow-invalid     exit 0 even when the quality report fails
  --rps <n>           Bybit request rate (default: 4)
  --quiet             progress lines off
  --help
`.trim();

interface Args {
  symbols: string[];
  from: MonthKey;
  to: MonthKey;
  interval: DataInterval;
  market: Market;
  dataDir?: string;
  reportDir?: string;
  funding: boolean;
  fundingOnly: boolean;
  tail: boolean;
  daily: boolean;
  force: boolean;
  validateOnly: boolean;
  allowInvalid: boolean;
  rps: number;
  quiet: boolean;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
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

  const symbolsRaw = flags.get("symbol") ?? flags.get("symbols");
  if (!symbolsRaw) fail("--symbol is required");
  const symbols = symbolsRaw.split(",").map((s) => normalizeSymbol(s));

  const from = flags.get("from");
  if (!from || !isMonthKey(from)) fail("--from must be YYYY-MM");
  const to = flags.get("to") ?? monthOf(Math.floor(Date.now() / 1000));
  if (!isMonthKey(to)) fail("--to must be YYYY-MM");
  if (monthStartSec(to) < monthStartSec(from)) fail("--to is before --from");

  const market = (flags.get("market") ?? "linear") as Market;
  if (market !== "linear" && market !== "spot") fail("--market must be linear or spot");

  const rps = Number(flags.get("rps") ?? 4);
  if (!Number.isFinite(rps) || rps <= 0) fail("--rps must be a positive number");

  return {
    symbols,
    from: from as MonthKey,
    to: to as MonthKey,
    interval: parseInterval(flags.get("interval") ?? "1m"),
    market,
    dataDir: flags.get("data-dir"),
    reportDir: flags.get("report"),
    funding: bare.has("funding") || bare.has("funding-only"),
    fundingOnly: bare.has("funding-only"),
    tail: !bare.has("no-tail"),
    daily: !bare.has("no-daily"),
    force: bare.has("force"),
    validateOnly: bare.has("validate-only"),
    allowInvalid: bare.has("allow-invalid"),
    rps,
    quiet: bare.has("quiet"),
  };
}

function createReporter(quiet: boolean): (e: ProgressEvent) => void {
  const tty = Boolean(process.stdout.isTTY);
  let lastAt = 0;
  return (e) => {
    if (quiet) return;
    const now = Date.now();
    const noisy = e.phase === "rest" || e.phase === "funding";
    if (noisy && now - lastAt < 400) return;
    lastAt = now;
    if (tty) {
      process.stdout.write(`\r\x1b[2K${e.message}`);
      if (!noisy) process.stdout.write("\n");
    } else {
      process.stdout.write(`${e.message}\n`);
    }
  };
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveDataRoot(args.dataDir);
  const outDir = args.reportDir ? path.resolve(args.reportDir) : reportsDir(root);
  const onProgress = createReporter(args.quiet);
  const store = createCandleStore(root);
  const fundingStore = createFundingStore(root);

  process.stdout.write(`data root: ${root}\n`);
  let failed = false;

  for (const symbol of args.symbols) {
    const key: DatasetKey = { market: args.market, symbol, interval: args.interval };
    process.stdout.write(`\n=== ${symbol} ${args.interval} ${args.from}..${args.to} ===\n`);

    // Validating against the clock as it was when the run started keeps a long
    // download from reporting the minutes that elapsed during it as missing.
    const asOf = Math.floor(Date.now() / 1000);

    if (!args.fundingOnly) {
      if (!args.validateOnly) {
        const result = await fetchDataset({
          root,
          key,
          from: args.from,
          to: args.to,
          force: args.force,
          tail: args.tail,
          daily: args.daily,
          store,
          onProgress,
          continueOnError: true,
          bybit: { rps: args.rps },
        });
        if (process.stdout.isTTY && !args.quiet) process.stdout.write("\n");
        const failures = result.months.filter((m) => m.action === "failed");
        for (const f of failures) process.stderr.write(`month ${f.month} failed: ${f.error}\n`);
        process.stdout.write(
          `fetched ${result.added} new bars in ${(result.durationMs / 1000).toFixed(1)}s ` +
            `(${result.requests.archives} monthly, ${result.requests.dailyArchives} daily archive requests)\n`,
        );
        if (failures.length > 0) failed = true;
      }

      const stats = store.stats(key);
      process.stdout.write(
        `store: ${stats.months} month file(s), ${stats.candles} bars, ${humanBytes(stats.bytes)}, sources ${stats.sources.join("+") || "-"}\n\n`,
      );

      const report = buildQualityReport(root, key, args.from, args.to, {
        store,
        nowSec: args.validateOnly ? undefined : asOf,
      });
      const text = formatQualityReport(report);
      const files = writeReportFiles(outDir, `${args.market}-${symbol}-${args.interval}-${args.from}_${args.to}`, report, text);
      process.stdout.write(`${text}\n\n`);
      process.stdout.write(`report: ${files.json}\n         ${files.txt}\n`);
      if (!report.ok) failed = true;
    }

    if (args.funding) {
      process.stdout.write("\n");
      let intervalMinutes: number | null = null;
      if (!args.validateOnly) {
        const res = await fetchFundingDataset({
          root,
          market: args.market,
          symbol,
          from: args.from,
          to: args.to,
          force: args.force,
          store: fundingStore,
          onProgress,
          bybit: { rps: args.rps },
        });
        if (process.stdout.isTTY && !args.quiet) process.stdout.write("\n");
        intervalMinutes = res.intervalMinutes;
        process.stdout.write(
          `funding: ${res.fetched} event(s) fetched, ${res.monthsWritten.length} month file(s) written in ${(res.durationMs / 1000).toFixed(1)}s\n`,
        );
      }

      const fromSec = monthStartSec(args.from);
      const toSec = Math.min(monthEndSec(args.to) - 1, Math.floor(Date.now() / 1000));
      const events = fundingStore.readRange(args.market, symbol, fromSec, toSec);
      if (intervalMinutes === null) {
        intervalMinutes = fundingStore.readMonthFile(args.market, symbol, args.from)?.intervalMinutes ?? null;
      }
      const report = validateFunding(events, { fromSec, toSec, intervalMinutes, symbol, market: args.market });
      const text = formatFundingReport(report);
      const files = writeReportFiles(outDir, `funding-${args.market}-${symbol}-${args.from}_${args.to}`, report, text);
      process.stdout.write(`\n${text}\n\n`);
      process.stdout.write(`report: ${files.json}\n         ${files.txt}\n`);
      if (!report.ok) failed = true;
    }
  }

  if (failed && !args.allowInvalid) {
    process.stderr.write("\nquality checks reported errors — see the report above\n");
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\n${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
