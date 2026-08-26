import fs from "node:fs";
import path from "node:path";
import { fetchMetrics } from "../src/lib/data/metricsFetch.ts";
import { assessMetrics } from "../src/lib/data/metricsQuality.ts";
import { createMetricsStore } from "../src/lib/data/metricsStore.ts";
import { reportsDir, resolveDataRoot } from "../src/lib/data/paths.ts";

/**
 * Downloads and validates the Binance positioning metrics — open interest,
 * top-trader long/short, taker buy/sell — on a five-minute grid.
 *
 *   npm run metrics:fetch -- --symbols BTCUSDT --from 2020-09-01 --to 2026-08-25
 *   npm run metrics:validate -- --symbols BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT
 *
 * A rerun skips days already on disk, so an interrupted download resumes.
 */

const USAGE = `
Usage:
  npm run metrics:fetch -- --symbols BTCUSDT,ETHUSDT --from 2020-09-01 --to 2026-08-25
  npm run metrics:validate -- --symbols BTCUSDT

  --symbols <list>    comma separated (default: BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT)
  --from <day>        YYYY-MM-DD (default: 2020-09-01, the first published day)
  --to <day>          YYYY-MM-DD (default: two days ago)
  --concurrency <n>   parallel downloads (default: 6)
  --rps <n>           request ceiling per second (default: 12)
  --no-checksum       skip the SHA256 sidecar (halves the requests, trusts the CDN)
  --force             re-download days already stored
  --validate-only     no network, just report what is on disk
  --data-dir <path>   dataset root (default: ./data, or $TRADING_DATA_DIR)
  --out <path>        report directory (default: <data-dir>/reports/metrics)
  --no-write          print only
  --quiet
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

function iso(sec: number | null): string {
  return sec === null ? "n/a" : new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function defaultToDay(): string {
  return new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const symbols = (arg(argv, "symbols") ?? "BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) fail("--symbols is empty");

  const fromDay = arg(argv, "from") ?? "2020-09-01";
  const toDay = arg(argv, "to") ?? defaultToDay();
  const validateOnly = argv.includes("--validate-only");
  const quiet = argv.includes("--quiet");
  const write = !argv.includes("--no-write");
  const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "metrics");

  const run = async (): Promise<void> => {
    const lines: string[] = [];
    lines.push(`metrics store ${path.join(dataRoot, "metrics", "binance")}`);
    lines.push(`symbols ${symbols.join(",")}  range ${fromDay} .. ${toDay}`);
    lines.push("");

    if (!validateOnly) {
      const res = await fetchMetrics({
        root: dataRoot,
        symbols,
        fromDay,
        toDay,
        force: argv.includes("--force"),
        concurrency: Number(arg(argv, "concurrency") ?? 6),
        rps: Number(arg(argv, "rps") ?? 12),
        verifyChecksum: !argv.includes("--no-checksum"),
        onProgress: quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
      });
      lines.push(`download finished in ${(res.elapsedMs / 1000).toFixed(1)}s`);
      lines.push(
        [
          pad("symbol", 10),
          padLeft("asked", 7),
          padLeft("cached", 7),
          padLeft("got", 7),
          padLeft("404", 6),
          padLeft("MB", 7),
          padLeft("bad", 5),
          pad("first", 12),
          pad("last", 12),
        ].join(" "),
      );
      for (const s of res.symbols) {
        lines.push(
          [
            pad(s.symbol, 10),
            padLeft(String(s.daysRequested), 7),
            padLeft(String(s.daysCached), 7),
            padLeft(String(s.daysDownloaded), 7),
            padLeft(String(s.daysMissing), 6),
            padLeft((s.zipBytes / 1e6).toFixed(2), 7),
            padLeft(String(s.malformed), 5),
            pad(s.firstDay ?? "n/a", 12),
            pad(s.lastDay ?? "n/a", 12),
          ].join(" "),
        );
        const empties = Object.entries(s.emptyFields).filter(([, v]) => v > 0);
        if (empties.length > 0) {
          lines.push(`    empty fields: ${empties.map(([k, v]) => `${k}=${v}`).join("  ")}`);
        }
        if (s.shortDays.length > 0) {
          const shown = s.shortDays.slice(0, 10).map((d) => `${d.day}:${d.rows}`).join("  ");
          lines.push(`    days not holding 288 rows (${s.shortDays.length}): ${shown}`);
        }
      }
      lines.push("");
    }

    const store = createMetricsStore(dataRoot);
    const quality: Record<string, unknown> = {};
    for (const symbol of symbols) {
      const stats = store.stats(symbol);
      const rows = store.readRange(symbol, 0, 4e9);
      const q = assessMetrics(rows);
      quality[symbol] = q;

      lines.push(`── ${symbol} ─────────────────────────────────────────────`);
      lines.push(
        `  months ${stats.months}  rows ${q.rows}  days ${stats.days}  on disk ${(stats.bytes / 1e6).toFixed(1)} MB`,
      );
      lines.push(`  span ${iso(q.firstSec)} .. ${iso(q.lastSec)}`);
      lines.push(
        `  coverage ${(q.coverage * 100).toFixed(3)}%  missing slots ${q.missingSlots}  gaps ${q.gapCount}` +
          `  off-grid ${q.offGrid}  duplicates ${q.duplicates}  unordered ${q.unordered}`,
      );
      const empties = Object.entries(q.emptyFields).filter(([, v]) => v > 0);
      lines.push(`  empty values: ${empties.length === 0 ? "none" : empties.map(([k, v]) => `${k}=${v}`).join("  ")}`);
      lines.push(`  non-positive open interest: ${q.nonPositiveOi}`);
      lines.push(
        `  5m log-change of OI: sd ${q.stepSdLogOi.toFixed(5)}  max |Δ| ${q.maxAbsStepLogOi.toFixed(4)} at ${iso(q.maxAbsStepAtSec)}`,
      );
      lines.push(`  frozen OI runs (>= 6 slots): ${q.flatRuns.length} listed, ${q.flatRows} rows total`);
      for (const r of q.flatRuns.slice(0, 8)) {
        lines.push(`    ${iso(r.fromSec)} .. ${iso(r.toSec)}  ${r.length} slots at ${r.value}`);
      }
      if (q.gaps.length > 0) {
        lines.push(`  largest gaps (${q.gaps.length} of ${q.gapCount} listed):`);
        for (const g of q.gaps.slice(0, 10)) {
          lines.push(`    ${iso(g.fromSec)} → ${iso(g.toSec)}   ${g.missing} slots (${(g.missing / 12).toFixed(1)} h)`);
        }
      }
      lines.push("");
    }

    const text = lines.join("\n");
    process.stdout.write(`${text}\n`);
    if (write) {
      fs.mkdirSync(outDir, { recursive: true });
      const base = path.join(outDir, `metrics-${fromDay}_${toDay}`);
      fs.writeFileSync(`${base}.txt`, `${text}\n`, "utf8");
      fs.writeFileSync(`${base}.json`, JSON.stringify(quality, null, 1), "utf8");
      if (!quiet) process.stderr.write(`\nwritten: ${base}.txt / .json\n`);
    }
  };

  run().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}

main();
