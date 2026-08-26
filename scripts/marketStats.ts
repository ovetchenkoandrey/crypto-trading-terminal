import fs from "node:fs";
import path from "node:path";
import { DATA_INTERVALS, isDataInterval, type DataInterval } from "../src/lib/data/interval.ts";
import { reportsDir, resolveDataRoot, type Market } from "../src/lib/data/paths.ts";
import { formatStudy } from "../src/lib/research/report.ts";
import { DEFAULT_HORIZONS, runStudy } from "../src/lib/research/study.ts";

/**
 * Measures the market itself rather than a strategy: how much serial structure
 * the price series carries, on which horizon, and how that compares with what a
 * round trip costs.
 *
 * Nothing here trades. The output is a description of the data, meant to be
 * read before deciding a hypothesis is worth implementing.
 */

const USAGE = `
Usage:
  npm run market-stats
  npm run market-stats -- --symbols BTCUSDT,ETHUSDT --from 2024-09 --to 2026-08

  --symbols <list>      comma separated (default: BTCUSDT,ETHUSDT)
  --market <name>       linear | spot (default: linear)
  --from <when>         YYYY-MM | YYYY-MM-DD | epoch seconds (default: dataset start)
  --to <when>           same shapes; a bare month means its last second
  --horizons <list>     comma separated (default: ${DEFAULT_HORIZONS.join(",")})
                        known: ${DATA_INTERVALS.join(", ")}
  --forecast-lags <n>   lags in the linear direction forecast (default: 5)
  --train <f>           fraction of each series used to fit it (default: 0.7)
  --data-dir <path>     dataset root (default: ./data, or $TRADING_DATA_DIR)
  --out <path>          report directory (default: <data-dir>/reports/market-stats)
  --no-write            print only, write no files
  --quiet               no progress lines
  --help
`.trim();

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
}

/** Accepts YYYY-MM, YYYY-MM-DD, an ISO instant, or epoch seconds. */
function parseWhen(raw: string, endOfPeriod: boolean): number {
  const value = raw.trim();
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [y, m] = value.split("-").map(Number);
    return endOfPeriod ? Date.UTC(y, m, 1) / 1000 - 1 : Date.UTC(y, m - 1, 1) / 1000;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return endOfPeriod ? Date.UTC(y, m - 1, d + 1) / 1000 - 1 : Date.UTC(y, m - 1, d) / 1000;
  }
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`cannot read a date from "${raw}"`);
  return Math.floor(parsed / 1000);
}

function parseHorizons(raw: string | undefined): DataInterval[] {
  if (!raw) return DEFAULT_HORIZONS;
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of out) if (!isDataInterval(h)) fail(`unknown horizon "${h}" (known: ${DATA_INTERVALS.join(", ")})`);
  return out as DataInterval[];
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const market = (arg(argv, "market") ?? "linear") as Market;
  if (market !== "linear" && market !== "spot") fail(`--market must be linear or spot`);

  const symbols = (arg(argv, "symbols") ?? "BTCUSDT,ETHUSDT")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) fail("--symbols is empty");

  const fromRaw = arg(argv, "from");
  const toRaw = arg(argv, "to");
  const fromSec = fromRaw ? parseWhen(fromRaw, false) : 0;
  const toSec = toRaw ? parseWhen(toRaw, true) : Math.floor(Date.now() / 1000);
  if (toSec <= fromSec) fail("--to must be after --from");

  const quiet = argv.includes("--quiet");
  const write = !argv.includes("--no-write");
  const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "market-stats");

  const started = Date.now();
  const result = runStudy({
    dataRoot,
    market,
    symbols,
    fromSec,
    toSec,
    horizons: parseHorizons(arg(argv, "horizons")),
    forecastLags: Number(arg(argv, "forecast-lags") ?? 5),
    trainFraction: Number(arg(argv, "train") ?? 0.7),
    onProgress: quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
  });

  const text = formatStudy(result);
  process.stdout.write(`${text}\n`);
  if (!quiet) process.stderr.write(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `market-stats-${stamp}`;
    fs.writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, `${base}.txt`), `${text}\n`);
    process.stderr.write(`report: ${path.join(outDir, `${base}.txt`)}\n`);
  }
}

main();
