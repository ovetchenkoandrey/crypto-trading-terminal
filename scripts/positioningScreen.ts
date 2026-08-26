import fs from "node:fs";
import path from "node:path";
import { isDataInterval, type DataInterval } from "../src/lib/data/interval.ts";
import { createMetricsStore } from "../src/lib/data/metricsStore.ts";
import { assessMetrics } from "../src/lib/data/metricsQuality.ts";
import { normalizeSymbol, reportsDir, resolveDataRoot, type Market } from "../src/lib/data/paths.ts";
import type { FeatureSpec } from "../src/lib/research/featureLib.ts";
import {
  alignmentDiagnostic,
  buildPositioningSeries,
  positioningFeatureSpecs,
  type PositioningSeriesSet,
} from "../src/lib/research/positioningFeatures.ts";
import { runScreen, type ScreenCell, type ScreenResult } from "../src/lib/research/screening.ts";

/**
 * Screens the Binance positioning archive — open interest, top-trader
 * long/short, taker buy/sell — through the same machine that screened the 63
 * price features, so the two answers are directly comparable.
 *
 *   npm run screen-positioning -- --from 2020-01 --to 2026-08
 *   npm run screen-positioning -- --with-price --shortlist 14
 *
 * The first form asks whether positioning predicts anything on its own. The
 * second puts it in the same room as the price features so the pair stage can
 * ask whether it works as a regime filter for what we already measured.
 */

const DEFAULT_TIMEFRAMES: DataInterval[] = ["15m", "1h", "4h", "1d"];
const DEFAULT_HORIZONS = [1, 4, 24, 96];

const USAGE = `
Usage:
  npm run screen-positioning -- --from 2020-01 --to 2026-08

  --symbols <list>      comma separated (default: BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT)
  --market <name>       linear | spot (default: linear)
  --from <when>         YYYY-MM | YYYY-MM-DD (default: 2020-01)
  --to <when>           same shapes (default: 2026-08)
  --timeframes <list>   default: ${DEFAULT_TIMEFRAMES.join(",")}
  --horizons <list>     forward bars, default: ${DEFAULT_HORIZONS.join(",")}
  --with-price          screen the 63 OHLCV features alongside (default: positioning only)
  --pin <list>          features forced into the regime and pair stages
  --publish-lag <sec>   how long after its stamp a snapshot counts as public (default: 300)
  --max-stale <sec>     drop a snapshot older than this at the bar close (default: 3600)
  --buckets <n>         quantile buckets (default: 5)
  --subperiods <n>      chronological slices per symbol (default: 4)
  --shortlist <n>       features taken into the regime and pair stages (default: 12)
  --cost <bps>          taker round trip for the economic comparison (default: 11)
  --data-dir <path>     dataset root
  --out <path>          report directory (default: <data-dir>/reports/positioning)
  --tag <name>          suffix for the report file name
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
  if (/^\d+$/.test(value)) return Number(value);
  fail(`cannot read a date from "${raw}"`);
}

function num(v: number, digits = 4): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "n/a";
}

function sci(p: number): string {
  return Number.isFinite(p) ? (p < 1e-4 ? p.toExponential(1) : p.toFixed(4)) : "n/a";
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

const HEADER = [
  pad("feature", 30),
  pad("tf", 4),
  padLeft("h", 4),
  padLeft("n", 9),
  padLeft("IC", 8),
  padLeft("z", 7),
  padLeft("p", 10),
  padLeft("sym", 6),
  padLeft("slice", 7),
  padLeft("spread", 9),
  padLeft("sprZ", 7),
  padLeft("mono", 6),
  padLeft("pEqual", 10),
].join(" ");

function cellLine(c: ScreenCell): string {
  return [
    pad(c.feature, 30),
    pad(c.timeframe, 4),
    padLeft(`h${c.horizon}`, 4),
    padLeft(String(c.n), 9),
    padLeft(num(c.ic, 4), 8),
    padLeft(num(c.z, 2), 7),
    padLeft(sci(c.p), 10),
    padLeft(`${c.symbolAgree}/${c.symbolTotal}`, 6),
    padLeft(`${c.sliceAgree}/${c.sliceTotal}`, 7),
    padLeft(num(c.spreadBps, 2), 9),
    padLeft(num(c.spreadZ, 2), 7),
    padLeft(num(c.monotonicity, 2), 6),
    padLeft(sci(c.pEqual), 10),
  ].join(" ");
}

interface DataNote {
  symbol: string;
  rows: number;
  coverage: number;
  missingSlots: number;
  gaps: number;
  offGrid: number;
  firstSec: number | null;
  lastSec: number | null;
  corrTakerPast: number;
  corrTakerNext: number;
  corrOiPast: number;
  corrOiNext: number;
}

function summarise(r: ScreenResult, notes: DataNote[], costBps: number, withPrice: boolean): string {
  const lines: string[] = [];
  const iso = (s: number | null): string =>
    s === null ? "n/a" : new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");

  lines.push(`positioning screen — ${withPrice ? "positioning + OHLCV catalogue" : "positioning features only"}`);
  lines.push(`market ${r.market}  symbols ${r.symbols.join(",")}  ${iso(r.fromSec)} .. ${iso(r.toSec)}`);
  lines.push(`features ${r.featureCount}  timeframes ${r.timeframes.join(",")}  horizons ${r.horizons.join(",")}`);
  lines.push(`buckets ${r.buckets}  subperiods ${r.subperiods}  cost ${costBps} bps  elapsed ${(r.elapsedMs / 1000).toFixed(1)}s`);
  lines.push("");

  lines.push("positioning data actually used:");
  lines.push(
    [
      pad("symbol", 10),
      padLeft("rows", 9),
      padLeft("cover", 8),
      padLeft("missing", 8),
      padLeft("gaps", 6),
      padLeft("offgrid", 8),
      pad("from", 18),
      pad("to", 18),
    ].join(" "),
  );
  for (const n of notes) {
    lines.push(
      [
        pad(n.symbol, 10),
        padLeft(String(n.rows), 9),
        padLeft(`${(n.coverage * 100).toFixed(2)}%`, 8),
        padLeft(String(n.missingSlots), 8),
        padLeft(String(n.gaps), 6),
        padLeft(String(n.offGrid), 8),
        pad(iso(n.firstSec), 18),
        pad(iso(n.lastSec), 18),
      ].join(" "),
    );
  }
  lines.push("");
  lines.push("timestamp convention check — which 5 minutes does a row describe?");
  lines.push("  (a row stamped T summarises the window it correlates with; the other one is hindsight)");
  lines.push(
    `  ${pad("symbol", 10)}${padLeft("taker vs [T-5m,T]", 20)}${padLeft("taker vs [T,T+5m]", 20)}` +
      `${padLeft("dOI vs [T-5m,T]", 18)}${padLeft("dOI vs [T,T+5m]", 18)}`,
  );
  for (const n of notes) {
    lines.push(
      `  ${pad(n.symbol, 10)}${padLeft(num(n.corrTakerPast, 4), 20)}${padLeft(num(n.corrTakerNext, 4), 20)}` +
        `${padLeft(num(n.corrOiPast, 4), 18)}${padLeft(num(n.corrOiNext, 4), 18)}`,
    );
  }
  lines.push("");

  lines.push("average pairwise return correlation across symbols (inflates the pooled SEs):");
  lines.push(`  ${Object.entries(r.crossCorr).map(([tf, v]) => `${tf}=${num(v, 3)}`).join("  ")}`);
  lines.push("");
  lines.push(
    `family: IC ${r.family.icTests} + shape ${r.family.shapeTests} + regime ${r.family.regimeTests} + pair ${r.family.pairTests} = ${r.family.total}`,
  );
  lines.push(
    `  Bonferroni |z| threshold ${num(r.family.zThreshold, 2)}   expected max |z| from pure noise ${num(r.family.expectedMaxZ, 2)}`,
  );
  lines.push("");

  const icBonf = r.icAdjusted.filter((a) => a.bonferroni < 0.05).length;
  const icBh = r.icAdjusted.filter((a) => a.bh < 0.05).length;
  lines.push(`IC family (${r.icAdjusted.length} tests): Bonferroni survivors ${icBonf}, BH survivors ${icBh}`);
  const shBonf = r.shapeAdjusted.filter((a) => a.bonferroni < 0.05).length;
  lines.push(`shape family (${r.shapeAdjusted.length} tests): Bonferroni survivors ${shBonf}`);
  lines.push("");

  // The decision the whole run exists to make.
  const big = r.cells.filter((c) => Math.abs(c.spreadBps) > costBps);
  const bigAndSignificant = big.filter((c) => Math.abs(c.spreadZ) > r.family.zThreshold);
  const bigAndNominal = big.filter((c) => Math.abs(c.spreadZ) > 1.96);
  lines.push(
    `cells whose quintile spread beats the ${costBps} bp taker round trip: ${big.length} of ${r.cells.length}`,
  );
  lines.push(
    `  of those, |z| over the family threshold ${num(r.family.zThreshold, 2)}: ${bigAndSignificant.length}` +
      `   |z| over the uncorrected 1.96: ${bigAndNominal.length}`,
  );
  lines.push("");
  lines.push(`top 20 by |spread| among cells that beat ${costBps} bp:`);
  lines.push(HEADER);
  for (const c of [...big].sort((a, b) => Math.abs(b.spreadZ) - Math.abs(a.spreadZ)).slice(0, 20)) {
    lines.push(cellLine(c));
  }
  if (big.length === 0) lines.push("  (none)");
  lines.push("");

  lines.push("top 50 cells by |z| of the information coefficient:");
  lines.push(HEADER);
  for (const c of r.cells.slice(0, 50)) lines.push(cellLine(c));
  lines.push("");

  const adjusted = new Map(r.icAdjusted.map((a) => [a.label, a]));
  lines.push("cells surviving Bonferroni on the IC family:");
  lines.push(HEADER);
  let any = false;
  for (const c of r.cells) {
    const a = adjusted.get(`${c.feature}|${c.timeframe}|h${c.horizon}`);
    if (!a || a.bonferroni >= 0.05) continue;
    any = true;
    lines.push(cellLine(c));
  }
  if (!any) lines.push("  (none)");
  lines.push("");

  lines.push("best cell per feature, sorted by |z|:");
  lines.push(HEADER);
  const best = new Map<string, ScreenCell>();
  for (const c of r.cells) {
    const prev = best.get(c.feature);
    if (!prev || Math.abs(c.z) > Math.abs(prev.z)) best.set(c.feature, c);
  }
  for (const c of Array.from(best.values()).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))) lines.push(cellLine(c));
  lines.push("");

  lines.push("best cell per feature by |spread| in basis points:");
  lines.push(HEADER);
  const bestSpread = new Map<string, ScreenCell>();
  for (const c of r.cells) {
    if (!Number.isFinite(c.spreadBps)) continue;
    const prev = bestSpread.get(c.feature);
    if (!prev || Math.abs(c.spreadBps) > Math.abs(prev.spreadBps)) bestSpread.set(c.feature, c);
  }
  for (const c of Array.from(bestSpread.values()).sort((a, b) => Math.abs(b.spreadBps) - Math.abs(a.spreadBps))) {
    lines.push(cellLine(c));
  }
  lines.push("");

  lines.push("survivors by timeframe and horizon:");
  const grouped = new Map<string, { tests: number; survivors: number; bestZ: number; bestSpread: number }>();
  for (const c of r.cells) {
    const key = `${c.timeframe}/h${c.horizon}`;
    const g = grouped.get(key) ?? { tests: 0, survivors: 0, bestZ: 0, bestSpread: 0 };
    g.tests++;
    const a = adjusted.get(`${c.feature}|${c.timeframe}|h${c.horizon}`);
    if (a && a.bonferroni < 0.05) g.survivors++;
    if (Math.abs(c.z) > Math.abs(g.bestZ)) g.bestZ = c.z;
    if (Number.isFinite(c.spreadBps) && Math.abs(c.spreadBps) > Math.abs(g.bestSpread)) g.bestSpread = c.spreadBps;
    grouped.set(key, g);
  }
  for (const [key, g] of Array.from(grouped.entries()).sort((a, b) => b[1].survivors - a[1].survivors)) {
    lines.push(
      `  ${pad(key, 10)}tests ${padLeft(String(g.tests), 4)}  survivors ${padLeft(String(g.survivors), 4)}` +
        `  best |z| ${padLeft(num(g.bestZ, 2), 7)}  best spread ${padLeft(num(g.bestSpread, 1), 9)} bp`,
    );
  }
  lines.push("");

  // Pooling can hide a result that lives on one symbol, and the pooled sign
  // count only checks the IC. When the decision rests on basis points, the
  // basis points have to be shown per symbol.
  lines.push(`per-symbol quintile spread for every cell that beats ${costBps} bp (sorted by |pooled z|):`);
  lines.push(
    `  ${pad("feature", 30)}${pad("tf/h", 9)}${padLeft("pooled", 9)}${padLeft("z", 7)}  ` +
      r.symbols.map((s) => padLeft(s.replace("USDT", ""), 9)).join(""),
  );
  for (const c of [...big].sort((a, b) => Math.abs(b.spreadZ) - Math.abs(a.spreadZ)).slice(0, 30)) {
    const bySymbol = new Map(c.perSymbol.map((s) => [s.symbol, s]));
    lines.push(
      `  ${pad(c.feature, 30)}${pad(`${c.timeframe}/h${c.horizon}`, 9)}${padLeft(num(c.spreadBps, 1), 9)}` +
        `${padLeft(num(c.spreadZ, 2), 7)}  ` +
        r.symbols
          .map((s) => {
            const cell = bySymbol.get(s);
            return padLeft(cell && Number.isFinite(cell.spreadBps) ? cell.spreadBps.toFixed(1) : "-", 9);
          })
          .join(""),
    );
  }
  lines.push("");

  lines.push("quantile profiles of the 25 strongest cells (basis points per bucket):");
  for (const c of r.cells.slice(0, 25)) {
    lines.push(
      `  ${pad(`${c.feature} ${c.timeframe} h${c.horizon}`, 40)}${c.bucketBps.map((v) => padLeft(num(v, 2), 9)).join("")}`,
    );
  }
  lines.push("");

  lines.push("regime conditioning (top 40 by |max pairwise z|):");
  for (const g of r.regimes.slice(0, 40)) {
    lines.push(
      `  ${pad(`${g.feature} ${g.timeframe} h${g.horizon} [${g.regime}]`, 50)}` +
        `maxDiffZ ${padLeft(num(g.maxDiffZ, 2), 7)}  chi2 ${padLeft(num(g.chi2, 1), 8)}  p ${sci(g.p)}  ${g.maxDiffLabel}`,
    );
    lines.push(`      ${g.perRegime.map((x) => `${x.label}: IC ${num(x.ic, 4)} (z ${num(x.z, 1)})`).join("  |  ")}`);
  }
  lines.push("");

  lines.push("pair interactions (sorted by p of the interaction, not by spread):");
  for (const p of r.pairs.slice(0, 50)) {
    lines.push(
      `  ${pad(`${p.featureA} x ${p.featureB} ${p.timeframe} h${p.horizon}`, 70)}` +
        `spread ${padLeft(num(p.spreadBps, 1), 9)} bp  chi2 ${padLeft(num(p.chi2Interaction, 1), 8)}  p ${sci(p.pInteraction)}  maxCellZ ${num(p.maxCellZ, 2)} @${p.maxCellLabel}`,
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
    .map((s) => normalizeSymbol(s.trim()))
    .filter(Boolean);

  const fromSec = parseWhen(arg(argv, "from") ?? "2020-01", false);
  const toSec = parseWhen(arg(argv, "to") ?? "2026-08", true);

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

  const withPrice = argv.includes("--with-price");
  const quiet = argv.includes("--quiet");
  const write = !argv.includes("--no-write");
  const costBps = Number(arg(argv, "cost") ?? 11);
  const publishLagSec = Number(arg(argv, "publish-lag") ?? 300);
  const maxStaleSec = Number(arg(argv, "max-stale") ?? 3600);
  const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "positioning");
  const tag = arg(argv, "tag") ?? (withPrice ? "mixed" : "positioning");

  const store = createMetricsStore(dataRoot);

  // One entry: the screener walks the symbols in order twice, so a bigger cache
  // would hold three idle grids to save two rebuilds.
  let cached: { symbol: string; set: PositioningSeriesSet } | null = null;
  const seriesFor = (symbol: string): PositioningSeriesSet => {
    if (cached?.symbol === symbol) return cached.set;
    const rows = store.readRange(symbol, fromSec, toSec);
    const set = buildPositioningSeries(rows);
    cached = { symbol, set };
    return set;
  };

  const notes: DataNote[] = [];
  for (const symbol of symbols) {
    const rows = store.readRange(symbol, fromSec, toSec);
    if (rows.length === 0) fail(`no positioning metrics stored for ${symbol}; run npm run metrics:fetch first`);
    const q = assessMetrics(rows);
    const set = buildPositioningSeries(rows);
    const diag = alignmentDiagnostic(set.grid);
    notes.push({
      symbol,
      rows: q.rows,
      coverage: q.coverage,
      missingSlots: q.missingSlots,
      gaps: q.gapCount,
      offGrid: q.offGrid,
      firstSec: q.firstSec,
      lastSec: q.lastSec,
      corrTakerPast: diag.corrWithPastBar,
      corrTakerNext: diag.corrWithNextBar,
      corrOiPast: diag.oiCorrWithPastBar,
      corrOiNext: diag.oiCorrWithNextBar,
    });
    cached = { symbol, set };
  }

  const extraFeatures = (symbol: string): FeatureSpec[] =>
    positioningFeatureSpecs(seriesFor(symbol), { publishLagSec, maxStaleSec });

  const pin = (arg(argv, "pin") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

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
    shortlist: Number(arg(argv, "shortlist") ?? 12),
    costBps,
    extraFeatures,
    includeBaseFeatures: withPrice,
    pinShortlist: pin,
    onProgress: quiet ? undefined : (m) => process.stderr.write(`  ${m}\n`),
  });

  const text = summarise(result, notes, costBps, withPrice);
  process.stdout.write(`${text}\n`);

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = `${new Date(fromSec * 1000).toISOString().slice(0, 7)}_${new Date(toSec * 1000).toISOString().slice(0, 7)}`;
    const base = path.join(outDir, `${tag}-${market}-${stamp}`);
    fs.writeFileSync(`${base}.txt`, `${text}\n`, "utf8");
    fs.writeFileSync(`${base}.json`, JSON.stringify({ notes, result }, null, 1), "utf8");
    if (!quiet) process.stderr.write(`\nwritten: ${base}.txt / .json\n`);
  }
}

main();
