import fs from "node:fs";
import path from "node:path";
import { isDataInterval, type DataInterval } from "../src/lib/data/interval.ts";
import { normalizeSymbol, reportsDir, resolveDataRoot, type Market } from "../src/lib/data/paths.ts";
import { runPositioningControl, type ControlRow } from "../src/lib/research/positioningControl.ts";

/**
 * Cuts the sample into quantile slices of a price feature and asks whether a
 * positioning feature's quintile spread is still there inside them.
 *
 *   npm run positioning-control -- --timeframe 1h --horizon 4 \
 *     --features pos_crowd_dev_24h --controls ret_24_norm,rsi_14
 *
 * A spread that vanishes under conditioning was the price feature all along.
 */

const USAGE = `
Usage:
  npm run positioning-control -- --timeframe 1h --horizon 4 --features <list> --controls <list>

  --symbols <list>      default: BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT
  --market <name>       linear | spot (default: linear)
  --from <when>         YYYY-MM (default: 2020-01)
  --to <when>           YYYY-MM (default: 2026-08)
  --timeframe <tf>      single timeframe (default: 1h)
  --horizon <n>         forward bars (default: 4)
  --features <list>     positioning features to test (required)
  --controls <list>     price features to control for (required)
  --buckets <n>         quantiles of the tested feature (default: 5)
  --control-buckets <n> slices of the control (default: 5)
  --cross-corr <r>      cross-symbol return correlation for the pooled SE (default: 0.66)
  --publish-lag <sec>   default 300
  --max-stale <sec>     default 3600
  --data-dir <path>
  --out <path>
  --tag <name>
  --no-write
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
  fail(`cannot read a date from "${raw}"`);
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

function line(r: ControlRow): string {
  return [
    pad(r.feature, 30),
    pad(r.control, 22),
    padLeft(String(r.n), 9),
    padLeft(num(r.rho, 3), 7),
    padLeft(num(r.spreadBps, 2), 9),
    padLeft(num(r.spreadZ, 2), 7),
    padLeft(num(r.conditionalSpreadBps, 2), 10),
    padLeft(num(r.conditionalSpreadZ, 2), 7),
    padLeft(num(r.retained, 2), 8),
    padLeft(num(r.controlSpreadBps, 2), 10),
    padLeft(num(r.controlSpreadZ, 2), 7),
  ].join(" ");
}

const HEADER = [
  pad("feature", 30),
  pad("control", 22),
  padLeft("n", 9),
  padLeft("rho", 7),
  padLeft("spread", 9),
  padLeft("z", 7),
  padLeft("cond", 10),
  padLeft("condZ", 7),
  padLeft("kept", 8),
  padLeft("ctrlSpr", 10),
  padLeft("ctrlZ", 7),
].join(" ");

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const market = (arg(argv, "market") ?? "linear") as Market;
  if (market !== "linear" && market !== "spot") fail("--market must be linear or spot");

  const symbols = (arg(argv, "symbols") ?? "BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT")
    .split(",")
    .map((s) => normalizeSymbol(s.trim()));

  const tf = arg(argv, "timeframe") ?? "1h";
  if (!isDataInterval(tf)) fail(`unknown timeframe "${tf}"`);

  const features = (arg(argv, "features") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const controls = (arg(argv, "controls") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (features.length === 0) fail("--features is required");
  if (controls.length === 0) fail("--controls is required");

  const quiet = argv.includes("--quiet");
  const write = !argv.includes("--no-write");

  const result = runPositioningControl({
    dataRoot,
    market,
    symbols,
    fromSec: parseWhen(arg(argv, "from") ?? "2020-01", false),
    toSec: parseWhen(arg(argv, "to") ?? "2026-08", true),
    timeframe: tf as DataInterval,
    horizon: Number(arg(argv, "horizon") ?? 4),
    features,
    controls,
    buckets: Number(arg(argv, "buckets") ?? 5),
    controlBuckets: Number(arg(argv, "control-buckets") ?? 5),
    crossCorr: Number(arg(argv, "cross-corr") ?? 0.66),
    asOf: {
      publishLagSec: Number(arg(argv, "publish-lag") ?? 300),
      maxStaleSec: Number(arg(argv, "max-stale") ?? 3600),
    },
    onProgress: quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
  });

  const lines: string[] = [];
  lines.push(`conditioning check — ${result.timeframe} horizon ${result.horizon} bars, symbols ${result.symbols.join(",")}`);
  lines.push("");
  lines.push("  spread   quintile spread of the positioning feature, basis points");
  lines.push("  cond     the same spread computed inside quantile slices of the control and pooled");
  lines.push("  kept     cond / spread. A near-perfect copy of the control keeps about 0.41");
  lines.push("           inside terciles and 0.25 inside quintiles, so read this against that,");
  lines.push("           not against zero.");
  lines.push("  ctrlSpr  the control's own quintile spread, for scale");
  lines.push("");
  lines.push(HEADER);
  for (const r of result.rows) lines.push(line(r));

  const text = lines.join("\n");
  process.stdout.write(`${text}\n`);

  if (write) {
    const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "positioning");
    fs.mkdirSync(outDir, { recursive: true });
    const tag = arg(argv, "tag") ?? `control-${tf}-h${arg(argv, "horizon") ?? 4}`;
    const base = path.join(outDir, tag);
    fs.writeFileSync(`${base}.txt`, `${text}\n`, "utf8");
    fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 1), "utf8");
    if (!quiet) process.stderr.write(`\nwritten: ${base}.txt / .json\n`);
  }
}

main();
