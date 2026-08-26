import fs from "node:fs";
import path from "node:path";
import { DATA_INTERVALS, isDataInterval, type DataInterval } from "../src/lib/data/interval.ts";
import { reportsDir, resolveDataRoot, type Market } from "../src/lib/data/paths.ts";
import {
  DEFAULT_HORIZONS,
  DEFAULT_TIMEFRAMES,
  runScreen,
  type ScreenCell,
  type ScreenResult,
} from "../src/lib/research/screening.ts";

/**
 * Screens the predictive power of every feature in the catalogue without
 * building a strategy around any of them.
 *
 * Eight hypotheses were rejected one implementation at a time. This asks the
 * same question a hundred times cheaper: for each signal, what is the rank
 * correlation between what it says now and what the market does next, how big is
 * that in basis points, and does it survive the fact that we looked at a
 * thousand slices.
 */

const USAGE = `
Usage:
  npm run screen-features
  npm run screen-features -- --symbols BTCUSDT,ETHUSDT --from 2020-01 --to 2026-08

  --symbols <list>      comma separated (default: BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT)
  --market <name>       linear | spot (default: linear)
  --from <when>         YYYY-MM | YYYY-MM-DD | epoch seconds (default: 2020-01)
  --to <when>           same shapes; a bare month means its last second
  --timeframes <list>   default: ${DEFAULT_TIMEFRAMES.join(",")} (known: ${DATA_INTERVALS.join(", ")})
  --horizons <list>     forward bars, default: ${DEFAULT_HORIZONS.join(",")}
  --buckets <n>         quantile buckets per feature (default: 5)
  --subperiods <n>      chronological slices per symbol (default: 4)
  --shortlist <n>       features taken into the regime and pair stages (default: 10)
  --cost <bps>          round-trip taker cost for the economic comparison (default: 11)
  --data-dir <path>     dataset root (default: ./data, or $TRADING_DATA_DIR)
  --out <path>          report directory (default: <data-dir>/reports/feature-screening)
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

function num(v: number, digits = 4): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "n/a";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function cellLine(c: ScreenCell): string {
  return [
    pad(c.feature, 24),
    pad(c.timeframe, 4),
    padLeft(`h${c.horizon}`, 4),
    padLeft(String(c.n), 9),
    padLeft(num(c.ic, 4), 8),
    padLeft(num(c.z, 2), 7),
    padLeft(c.p < 1e-4 ? c.p.toExponential(1) : num(c.p, 4), 10),
    padLeft(`${c.symbolAgree}/${c.symbolTotal}`, 6),
    padLeft(`${c.sliceAgree}/${c.sliceTotal}`, 7),
    padLeft(num(c.spreadBps, 2), 10),
    padLeft(num(c.spreadZ, 2), 7),
    padLeft(num(c.monotonicity, 2), 6),
    padLeft(num(c.curvatureBps, 2), 9),
    padLeft(num(c.curvatureZ, 2), 7),
    padLeft(c.pEqual < 1e-4 ? c.pEqual.toExponential(1) : num(c.pEqual, 4), 10),
  ].join(" ");
}

const HEADER = [
  pad("feature", 24),
  pad("tf", 4),
  padLeft("h", 4),
  padLeft("n", 9),
  padLeft("IC", 8),
  padLeft("z", 7),
  padLeft("p", 10),
  padLeft("sym", 6),
  padLeft("slice", 7),
  padLeft("spread", 10),
  padLeft("sprZ", 7),
  padLeft("mono", 6),
  padLeft("curv", 9),
  padLeft("curvZ", 7),
  padLeft("pEqual", 10),
].join(" ");

function summarise(r: ScreenResult): string {
  const lines: string[] = [];
  const iso = (s: number): string => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
  lines.push(`market ${r.market}  symbols ${r.symbols.join(",")}  ${iso(r.fromSec)} .. ${iso(r.toSec)}`);
  lines.push(`features ${r.featureCount}  timeframes ${r.timeframes.join(",")}  horizons ${r.horizons.join(",")}`);
  lines.push(`buckets ${r.buckets}  subperiods ${r.subperiods}  cost ${r.costBps} bps  elapsed ${(r.elapsedMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("bars per symbol and timeframe:");
  for (const [symbol, frames] of Object.entries(r.perSymbolBars)) {
    lines.push(`  ${pad(symbol, 10)}${Object.entries(frames).map(([tf, n]) => `${tf}=${n}`).join("  ")}`);
  }
  lines.push("");
  lines.push("average pairwise return correlation across symbols (used to inflate pooled SEs):");
  lines.push(`  ${Object.entries(r.crossCorr).map(([tf, v]) => `${tf}=${num(v, 3)}`).join("  ")}`);
  lines.push("");
  lines.push(
    `family: IC ${r.family.icTests} + shape ${r.family.shapeTests} + regime ${r.family.regimeTests} + pair ${r.family.pairTests} = ${r.family.total}`,
  );
  lines.push(
    `  Bonferroni |z| threshold ${num(r.family.zThreshold, 2)}   expected max |z| from pure noise ${num(r.family.expectedMaxZ, 2)}`,
  );
  lines.push("");

  const byBonf = r.icAdjusted.filter((a) => a.bonferroni < 0.05).length;
  const byBh = r.icAdjusted.filter((a) => a.bh < 0.05).length;
  lines.push(`IC family (${r.icAdjusted.length} tests): Bonferroni survivors ${byBonf}, BH survivors ${byBh}`);
  const shapeBonf = r.shapeAdjusted.filter((a) => a.bonferroni < 0.05).length;
  const shapeBh = r.shapeAdjusted.filter((a) => a.bh < 0.05).length;
  lines.push(`shape family (${r.shapeAdjusted.length} tests): Bonferroni survivors ${shapeBonf}, BH survivors ${shapeBh}`);
  lines.push("");

  lines.push("top 60 cells by |z|:");
  lines.push(HEADER);
  for (const c of r.cells.slice(0, 60)) lines.push(cellLine(c));
  lines.push("");

  const adjustedByLabel = new Map(r.icAdjusted.map((a) => [a.label, a]));
  lines.push("cells surviving Bonferroni on the IC family:");
  lines.push(HEADER);
  let any = false;
  for (const c of r.cells) {
    const a = adjustedByLabel.get(`${c.feature}|${c.timeframe}|h${c.horizon}`);
    if (!a || a.bonferroni >= 0.05) continue;
    any = true;
    lines.push(cellLine(c));
  }
  if (!any) lines.push("  (none)");
  lines.push("");

  const shapeByLabel = new Map(r.shapeAdjusted.map((a) => [a.label, a]));
  lines.push("cells whose quantile means differ, surviving Bonferroni on the shape family:");
  lines.push(HEADER);
  let anyShape = false;
  for (const c of [...r.cells].sort((a, b) => a.pEqual - b.pEqual)) {
    const a = shapeByLabel.get(`${c.feature}|${c.timeframe}|h${c.horizon}`);
    if (!a || a.bonferroni >= 0.05) continue;
    anyShape = true;
    lines.push(cellLine(c));
  }
  if (!anyShape) lines.push("  (none)");
  lines.push("");

  lines.push("best cell per feature (sorted by |z|):");
  lines.push(HEADER);
  const best = new Map<string, ScreenCell>();
  for (const c of r.cells) {
    const prev = best.get(c.feature);
    if (!prev || Math.abs(c.z) > Math.abs(prev.z)) best.set(c.feature, c);
  }
  for (const c of Array.from(best.values()).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))) lines.push(cellLine(c));
  lines.push("");

  lines.push("quantile profiles for the shortlist (basis points per bucket):");
  for (const c of r.cells.slice(0, 25)) {
    lines.push(
      `  ${pad(`${c.feature} ${c.timeframe} h${c.horizon}`, 34)}${c.bucketBps.map((v) => padLeft(num(v, 2), 9)).join("")}`,
    );
  }
  lines.push("");

  lines.push("regime conditioning (top 40 by |max pairwise z|):");
  for (const g of r.regimes.slice(0, 40)) {
    lines.push(
      `  ${pad(`${g.feature} ${g.timeframe} h${g.horizon} [${g.regime}]`, 44)}` +
        `maxDiffZ ${padLeft(num(g.maxDiffZ, 2), 7)}  chi2 ${padLeft(num(g.chi2, 1), 8)}  p ${g.p < 1e-4 ? g.p.toExponential(1) : num(g.p, 4)}  ${g.maxDiffLabel}`,
    );
    lines.push(`      ${g.perRegime.map((x) => `${x.label}: IC ${num(x.ic, 4)} (z ${num(x.z, 1)})`).join("  |  ")}`);
  }
  lines.push("");

  lines.push("pair interactions (sorted by p):");
  for (const p of r.pairs.slice(0, 40)) {
    lines.push(
      `  ${pad(`${p.featureA} x ${p.featureB} ${p.timeframe} h${p.horizon}`, 60)}` +
        `spread ${padLeft(num(p.spreadBps, 1), 9)} bps  chi2 ${padLeft(num(p.chi2Interaction, 1), 8)}  p ${p.pInteraction < 1e-4 ? p.pInteraction.toExponential(1) : num(p.pInteraction, 4)}  maxCellZ ${num(p.maxCellZ, 2)} @${p.maxCellLabel}`,
    );
  }

  return lines.join("\n");
}

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
    .map((s) => s.trim())
    .filter(Boolean);
  if (symbols.length === 0) fail("--symbols is empty");

  const fromSec = parseWhen(arg(argv, "from") ?? "2020-01", false);
  const toSec = parseWhen(arg(argv, "to") ?? "2026-08", true);
  if (toSec <= fromSec) fail("--to must be after --from");

  const tfRaw = (arg(argv, "timeframes") ?? DEFAULT_TIMEFRAMES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const tf of tfRaw) if (!isDataInterval(tf)) fail(`unknown timeframe "${tf}"`);
  const timeframes = tfRaw as DataInterval[];

  const horizons = (arg(argv, "horizons") ?? DEFAULT_HORIZONS.join(","))
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 1);
  if (horizons.length === 0) fail("--horizons is empty");

  const quiet = argv.includes("--quiet");
  const write = !argv.includes("--no-write");
  const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "feature-screening");

  const result = runScreen({
    dataRoot,
    market,
    symbols,
    fromSec,
    toSec,
    timeframes,
    horizons,
    buckets: Number(arg(argv, "buckets") ?? 5),
    subperiods: Number(arg(argv, "subperiods") ?? 4),
    shortlist: Number(arg(argv, "shortlist") ?? 10),
    costBps: Number(arg(argv, "cost") ?? 11),
    onProgress: quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
  });

  const text = summarise(result);
  process.stdout.write(`${text}\n`);

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = `${new Date(fromSec * 1000).toISOString().slice(0, 7)}_${new Date(toSec * 1000).toISOString().slice(0, 7)}`;
    const base = path.join(outDir, `screen-${market}-${stamp}`);
    fs.writeFileSync(`${base}.txt`, `${text}\n`, "utf8");
    fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 1), "utf8");
    if (!quiet) process.stderr.write(`\nwritten: ${base}.txt / .json\n`);
  }
}

main();
