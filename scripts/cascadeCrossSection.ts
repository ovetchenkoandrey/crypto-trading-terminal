import fs from "node:fs";
import path from "node:path";
import { createCandleStore } from "../src/lib/data/candleStore.ts";
import { reportsDir, resolveDataRoot } from "../src/lib/data/paths.ts";
import { toISO } from "../src/lib/data/months.ts";
import { CASCADE_UNIVERSE, UNIVERSE_SYMBOLS, universeSymbol } from "../src/lib/data/universe.ts";
import {
  FORWARD_HORIZONS,
  clusterEvents,
  effectiveSampleSize,
  extractEvents,
  reproducibility,
  summariseSimultaneity,
  symbolEffect,
  type CascadeEvent,
  type ForwardHorizon,
} from "../src/lib/bots/cascadeCrossSection.ts";

/**
 * Measures the cascade effect across the whole universe and, more importantly,
 * measures how much of the extra sample size breadth actually buys.
 *
 * Order of the questions matters and is deliberate. Simultaneity is answered
 * before the effect, because if every symbol fires in the same minute then the
 * effect size is beside the point: there is no more statistics than there was
 * with four symbols, and the hypothesis dies on arithmetic rather than on edge.
 *
 * Nothing here trades. Extracted events are cached to disk so the portfolio
 * runs can replay them without re-reading a gigabyte of minutes.
 */

const USAGE = `
Usage:
  npm run cascade:xsec
  npm run cascade:xsec -- --to 2024-12-31 --percentile 0.9999

  --symbols <list>     comma separated (default: the frozen universe)
  --from <when>        YYYY-MM | YYYY-MM-DD (default: 2022-01)
  --to <when>          same (default: 2026-08)
  --percentile <p>     expanding-window quantile for the trigger (default: 0.9999)
  --warmup <bars>      bars before the first event is allowed (default: 129600)
  --cooldown <bars>    bars between events on one symbol (default: 60)
  --cluster <min>      simultaneity window in minutes (default: 5)
  --hold-cap <bars>    stored forward path length (default: 120)
  --report-to <date>   report only on events up to this day, inclusive. The cache
                       still covers the full range; this keeps the out-of-sample
                       period out of the report without re-extracting.
  --report-from <date> report only on events from this day onward. Needs --oos.
  --oos                permit --report-from to open the reserved window
  --cache <path>       event cache file (default: <data>/reports/cascade-events-<from>_<to>.json)
  --refresh            re-extract even when the cache matches
  --data-dir <path>    dataset root
  --json               also write the report as JSON
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

function parseWhen(raw: string, end: boolean): number {
  const v = raw.trim();
  if (/^\d{4}-\d{2}$/.test(v)) {
    const [y, m] = v.split("-").map(Number);
    return end ? Date.UTC(y, m, 1) / 1000 - 1 : Date.UTC(y, m - 1, 1) / 1000;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return end ? Date.UTC(y, m - 1, d + 1) / 1000 - 1 : Date.UTC(y, m - 1, d) / 1000;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(`cannot read a date from "${raw}"`);
  return Math.floor(t / 1000);
}

export interface EventCache {
  version: number;
  fromSec: number;
  toSec: number;
  percentile: number;
  warmupBars: number;
  cooldownBars: number;
  holdCap: number;
  symbols: string[];
  events: CascadeEvent[];
  coverage: { symbol: string; bars: number; firstTime: number; lastTime: number; events: number }[];
}

const CACHE_VERSION = 1;

function pad(s: string | number, n: number): string {
  return String(s).padStart(n);
}

function padR(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

function fmt(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const symbols = (arg(argv, "symbols") ?? UNIVERSE_SYMBOLS.join(","))
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const fromSec = parseWhen(arg(argv, "from") ?? "2022-01", false);
  const toSec = parseWhen(arg(argv, "to") ?? "2026-08", true);
  const percentile = Number(arg(argv, "percentile") ?? 0.9999);
  const warmupBars = Number(arg(argv, "warmup") ?? 129_600);
  const cooldownBars = Number(arg(argv, "cooldown") ?? 60);
  const clusterMin = Number(arg(argv, "cluster") ?? 5);
  const holdCap = Number(arg(argv, "hold-cap") ?? 120);
  const refresh = argv.includes("--refresh");
  const wantJson = argv.includes("--json");

  const label = `${toISO(fromSec).slice(0, 10)}_${toISO(toSec).slice(0, 10)}`;
  const cacheFile = arg(argv, "cache") ?? path.join(reportsDir(dataRoot), `cascade-events-${label}.json`);

  const cache = loadOrBuild({
    cacheFile, refresh, dataRoot, symbols, fromSec, toSec, percentile, warmupBars, cooldownBars, holdCap,
  });

  const reportTo = arg(argv, "report-to");
  const reportFrom = arg(argv, "report-from");
  if (reportFrom !== undefined && !argv.includes("--oos")) {
    fail("--report-from opens the reserved out-of-sample window; pass --oos to mean it");
  }
  let view = cache;
  if (reportTo !== undefined || reportFrom !== undefined) {
    const lo = reportFrom !== undefined ? parseWhen(reportFrom, false) : cache.fromSec;
    const hi = reportTo !== undefined ? parseWhen(reportTo, true) : cache.toSec;
    const events = cache.events.filter((e) => e.time >= lo && e.time <= hi);
    const kept = new Map<string, number>();
    for (const e of events) kept.set(e.symbol, (kept.get(e.symbol) ?? 0) + 1);
    view = {
      ...cache,
      fromSec: lo,
      toSec: hi,
      events,
      coverage: cache.coverage.map((c) => ({ ...c, events: kept.get(c.symbol) ?? 0 })),
    };
  }

  report(view, clusterMin, wantJson ? cacheFile.replace(/\.json$/, "-report.json") : null);
}

function loadOrBuild(o: {
  cacheFile: string; refresh: boolean; dataRoot: string; symbols: string[];
  fromSec: number; toSec: number; percentile: number; warmupBars: number;
  cooldownBars: number; holdCap: number;
}): EventCache {
  if (!o.refresh && fs.existsSync(o.cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(o.cacheFile, "utf8")) as EventCache;
      const same =
        cached.version === CACHE_VERSION &&
        cached.fromSec === o.fromSec && cached.toSec === o.toSec &&
        cached.percentile === o.percentile && cached.warmupBars === o.warmupBars &&
        cached.cooldownBars === o.cooldownBars && cached.holdCap === o.holdCap &&
        cached.symbols.join(",") === o.symbols.join(",");
      if (same) {
        process.stderr.write(`cache hit: ${o.cacheFile} (${cached.events.length} events)\n`);
        return cached;
      }
      process.stderr.write(`cache exists but does not match this configuration — re-extracting\n`);
    } catch {
      process.stderr.write(`cache unreadable — re-extracting\n`);
    }
  }

  const store = createCandleStore(o.dataRoot);
  const events: CascadeEvent[] = [];
  const coverage: EventCache["coverage"] = [];

  for (const symbol of o.symbols) {
    const started = Date.now();
    let bars;
    try {
      bars = store.readRange({ market: "linear", symbol, interval: "1m" }, o.fromSec, o.toSec);
    } catch (err) {
      process.stderr.write(`  ${symbol}: unreadable (${(err as Error).message})\n`);
      continue;
    }
    if (bars.length === 0) {
      process.stderr.write(`  ${symbol}: no data in range — skipped\n`);
      continue;
    }
    const found = extractEvents(bars, {
      symbol,
      holdCap: o.holdCap,
      params: { percentile: o.percentile, warmupBars: o.warmupBars, cooldownBars: o.cooldownBars },
    });
    events.push(...found);
    coverage.push({
      symbol, bars: bars.length, firstTime: bars[0].time, lastTime: bars[bars.length - 1].time, events: found.length,
    });
    process.stderr.write(
      `  ${padR(symbol, 14)} ${pad(bars.length, 9)} bars  ${pad(found.length, 4)} events  ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
  }

  const cache: EventCache = {
    version: CACHE_VERSION,
    fromSec: o.fromSec, toSec: o.toSec, percentile: o.percentile,
    warmupBars: o.warmupBars, cooldownBars: o.cooldownBars, holdCap: o.holdCap,
    symbols: o.symbols, events, coverage,
  };
  fs.mkdirSync(path.dirname(o.cacheFile), { recursive: true });
  fs.writeFileSync(o.cacheFile, JSON.stringify(cache));
  process.stderr.write(`cache written: ${o.cacheFile}\n`);
  return cache;
}

function report(cache: EventCache, clusterMin: number, jsonOut: string | null): void {
  const out: string[] = [];
  const w = (s = "") => out.push(s);

  const events = cache.events;
  const spanDays = (cache.toSec - cache.fromSec) / 86_400;
  const spanYears = spanDays / 365.25;

  w("=".repeat(78));
  w("CASCADE CROSS-SECTION");
  w("=".repeat(78));
  w(`Window        ${toISO(cache.fromSec)} .. ${toISO(cache.toSec)}  (${spanYears.toFixed(2)} years)`);
  w(`Symbols       ${cache.coverage.length} of ${cache.symbols.length} requested`);
  w(`Trigger       expanding-window ${cache.percentile} quantile of 1-bar |move|, ` +
    `warm-up ${cache.warmupBars} bars, cooldown ${cache.cooldownBars}`);
  w(`Events        ${events.length}  (${(events.length / spanYears).toFixed(0)}/year portfolio-wide, ` +
    `${(events.length / cache.coverage.length / spanYears).toFixed(1)}/year/symbol)`);
  w();

  /* ── 1. simultaneity, asked first ─────────────────────────────────────── */

  w("-".repeat(78));
  w("1. SIMULTANEITY — is a market-wide flush one observation or forty?");
  w("-".repeat(78));
  w();
  w(padR("window", 10) + pad("clusters", 10) + pad("mean size", 11) + pad("max size", 10) +
    pad("clustered", 11) + pad("share", 8));
  const windows = [1, 2, 5, 15, 30, 60];
  const clusterTables: { min: number; report: ReturnType<typeof summariseSimultaneity> }[] = [];
  for (const min of windows) {
    const cl = clusterEvents(events, min * 60);
    const s = summariseSimultaneity(cl);
    clusterTables.push({ min, report: s });
    w(padR(`${min} min`, 10) + pad(s.clusters, 10) + pad(fmt(s.meanClusterSize), 11) +
      pad(s.maxClusterSize, 10) + pad(s.clusteredEvents, 11) + pad(`${(s.clusteredShare * 100).toFixed(1)}%`, 8));
  }
  w();

  const main = clusterEvents(events, clusterMin * 60);
  const mainReport = summariseSimultaneity(main);
  w(`At the ${clusterMin}-minute window:`);
  w(`  ${mainReport.clusters} independent flushes for ${mainReport.events} events ` +
    `(${(mainReport.events / Math.max(1, mainReport.clusters)).toFixed(2)} symbols per flush)`);
  w(`  ${(mainReport.clusteredShare * 100).toFixed(1)}% of events share their minute with another symbol`);
  w(`  biggest flush: ${mainReport.maxClusterSize} symbols at ${toISO(mainReport.largestClusterTime)}`);
  w(`  ${mainReport.largestClusterSymbols.slice(0, 20).join(" ")}`);
  w();
  w("  cluster size histogram (symbols per flush -> count of flushes)");
  const hist = mainReport.sizeHistogram;
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === 0) continue;
    w(`    ${pad(i + 1, 3)}: ${pad(hist[i], 5)}  ${"#".repeat(Math.min(50, hist[i]))}`);
  }
  w();

  w("  effect by flush size — is the market-wide event the one that reverts?");
  w("  " + padR("flush holds", 14) + pad("events", 8) + pad("flushes", 9) +
    pad("mean bps", 11) + pad("t naive", 9) + pad("t cluster", 11));
  const sizeBands: [number, number, string][] = [
    [1, 1, "1 symbol"], [2, 3, "2-3"], [4, 9, "4-9"], [10, 24, "10-24"], [25, 99, "25+"],
  ];
  for (const [lo, hi, name] of sizeBands) {
    const subset = main.filter((c) => c.symbols.length >= lo && c.symbols.length <= hi);
    if (subset.length === 0) continue;
    const eff = effectiveSampleSize(subset, (e) => e.fadeCloseBps[60 as ForwardHorizon]);
    w("  " + padR(name, 14) + pad(eff.n, 8) + pad(subset.length, 9) +
      pad(fmt(eff.meanBps), 11) + pad(fmt(eff.naiveT), 9) + pad(fmt(eff.clusterT), 11));
  }
  w();

  /* ── 2. effect and effective sample size per horizon ──────────────────── */

  w("-".repeat(78));
  w("2. EFFECT AND EFFECTIVE SAMPLE SIZE");
  w("-".repeat(78));
  w();
  for (const basis of ["fadeCloseBps", "fadeOpenBps"] as const) {
    w(basis === "fadeCloseBps"
      ? "close-to-close (what the effect is, not what a market order gets)"
      : "open-to-open from the bar after the trigger (what a market order gets)");
    w("  " + padR("horizon", 9) + pad("n", 6) + pad("mean bps", 11) + pad("median", 9) +
      pad("win%", 8) + pad("t naive", 9) + pad("t cluster", 11) + pad("ICC", 7) + pad("N_eff", 9));
    for (const h of FORWARD_HORIZONS) {
      const outcome = (e: CascadeEvent) => e[basis][h as ForwardHorizon];
      const eff = effectiveSampleSize(main, outcome);
      const vals = events.map(outcome).filter((v): v is number => v !== undefined && Number.isFinite(v));
      const sorted = [...vals].sort((a, b) => a - b);
      const med = sorted.length === 0 ? Number.NaN : sorted[Math.floor(sorted.length / 2)];
      const win = vals.length === 0 ? Number.NaN : vals.filter((v) => v > 0).length / vals.length;
      w("  " + padR(`${h}m`, 9) + pad(eff.n, 6) + pad(fmt(eff.meanBps), 11) + pad(fmt(med), 9) +
        pad(`${(win * 100).toFixed(1)}`, 8) + pad(fmt(eff.naiveT), 9) + pad(fmt(eff.clusterT), 11) +
        pad(fmt(eff.icc, 3), 7) + pad(fmt(eff.effectiveN, 0), 9));
    }
    w();
  }

  /* ── 3. reproducibility across symbols ────────────────────────────────── */

  w("-".repeat(78));
  w("3. REPRODUCIBILITY — does it exist outside the four it was found on?");
  w("-".repeat(78));
  w();
  const HORIZON: ForwardHorizon = 60;
  const outcome60 = (e: CascadeEvent) => e.fadeCloseBps[HORIZON];
  const bySymbol = new Map<string, CascadeEvent[]>();
  for (const e of events) {
    const list = bySymbol.get(e.symbol) ?? [];
    list.push(e);
    bySymbol.set(e.symbol, list);
  }
  const effects = cache.coverage.map((c) => symbolEffect(c.symbol, bySymbol.get(c.symbol) ?? [], outcome60));
  const ORIGINAL = new Set(["BTCUSDT", "ETHUSDT", "XRPUSDT", "SOLUSDT"]);

  w(`fade at ${HORIZON}m, close-to-close, per symbol`);
  w("  " + padR("symbol", 14) + pad("n", 5) + pad("mean bps", 11) + pad("median", 9) +
    pad("win%", 8) + pad("t", 8) + pad("top1 share", 12) + "  tier / 24h vol");
  for (const e of [...effects].sort((a, b) => b.meanBps - a.meanBps)) {
    const u = universeSymbol(e.symbol);
    const mark = ORIGINAL.has(e.symbol) ? "*" : " ";
    w("  " + padR(mark + e.symbol, 14) + pad(e.n, 5) + pad(fmt(e.meanBps), 11) + pad(fmt(e.medianBps), 9) +
      pad(`${(e.winRate * 100).toFixed(0)}`, 8) + pad(fmt(e.t), 8) + pad(fmt(e.topShare, 2), 12) +
      `  ${padR(u?.tier ?? "?", 6)} ${u ? (u.volumeUsdt / 1e6).toFixed(0) + "M" : ""}`);
  }
  w("  (* = one of the four symbols the effect was originally found on)");
  w();

  const all = reproducibility(effects);
  const outside = reproducibility(effects.filter((e) => !ORIGINAL.has(e.symbol)));
  const original = reproducibility(effects.filter((e) => ORIGINAL.has(e.symbol)));
  w(`  all symbols      ${all.positive}/${all.symbols} positive ` +
    `(${(all.share * 100).toFixed(0)}%), binomial z ${fmt(all.z)}`);
  w(`  original four    ${original.positive}/${original.symbols} positive`);
  w(`  the other ${padR(outside.symbols, 6)} ${outside.positive}/${outside.symbols} positive ` +
    `(${(outside.share * 100).toFixed(0)}%), binomial z ${fmt(outside.z)}`);
  w();

  const meanOriginal = avg(effects.filter((e) => ORIGINAL.has(e.symbol)).map((e) => e.meanBps));
  const meanOutside = avg(effects.filter((e) => !ORIGINAL.has(e.symbol)).map((e) => e.meanBps));
  w(`  mean of per-symbol means: original four ${fmt(meanOriginal)} bps, ` +
    `the rest ${fmt(meanOutside)} bps`);
  w(`  the gap is the selection premium: the four were picked after the fact.`);
  w();

  /* ── 4. liquidity and size ────────────────────────────────────────────── */

  w("-".repeat(78));
  w("4. DOES THE EFFECT DEPEND ON LIQUIDITY?");
  w("-".repeat(78));
  w();
  w("  " + padR("tier", 8) + pad("symbols", 9) + pad("events", 8) + pad("mean bps", 11) +
    pad("t naive", 9) + pad("t cluster", 11) + pad("N_eff", 8));
  for (const tier of ["mega", "large", "mid"] as const) {
    const syms = new Set(CASCADE_UNIVERSE.filter((s) => s.tier === tier).map((s) => s.symbol));
    const subset = events.filter((e) => syms.has(e.symbol));
    if (subset.length === 0) continue;
    const eff = effectiveSampleSize(clusterEvents(subset, clusterMin * 60), outcome60);
    const present = cache.coverage.filter((c) => syms.has(c.symbol)).length;
    w("  " + padR(tier, 8) + pad(present, 9) + pad(subset.length, 8) + pad(fmt(eff.meanBps), 11) +
      pad(fmt(eff.naiveT), 9) + pad(fmt(eff.clusterT), 11) + pad(fmt(eff.effectiveN, 0), 8));
  }
  w();

  const ranked = effects.filter((e) => e.n >= 5 && Number.isFinite(e.meanBps));
  const logVol = ranked.map((e) => Math.log(Math.max(1, universeSymbol(e.symbol)?.volumeUsdt ?? 1)));
  const means = ranked.map((e) => e.meanBps);
  w(`  rank correlation between 24h volume and per-symbol mean fade: ` +
    `${fmt(spearman(logVol, means), 3)}  (n = ${ranked.length} symbols)`);
  w();

  w("  by trigger size (all symbols pooled, fade at 60m close-to-close)");
  w("  " + padR("|move|", 14) + pad("n", 7) + pad("mean bps", 11) + pad("t naive", 9) + pad("t cluster", 11));
  const buckets: [number, number][] = [[90, 150], [150, 250], [250, 400], [400, 700], [700, 1e9]];
  for (const [lo, hi] of buckets) {
    const subset = events.filter((e) => Math.abs(e.moveBps) >= lo && Math.abs(e.moveBps) < hi);
    if (subset.length === 0) continue;
    const eff = effectiveSampleSize(clusterEvents(subset, clusterMin * 60), outcome60);
    const name = hi > 1e8 ? `${lo}+ bps` : `${lo}-${hi} bps`;
    w("  " + padR(name, 14) + pad(eff.n, 7) + pad(fmt(eff.meanBps), 11) +
      pad(fmt(eff.naiveT), 9) + pad(fmt(eff.clusterT), 11));
  }
  w();

  /* ── 5. concentration in time ─────────────────────────────────────────── */

  w("-".repeat(78));
  w("5. CONCENTRATION — how many days carry the result?");
  w("-".repeat(78));
  w();
  const byDay = new Map<number, number>();
  for (const e of events) {
    const v = e.fadeCloseBps[HORIZON];
    if (v === undefined || !Number.isFinite(v)) continue;
    const d = Math.floor(e.time / 86_400);
    byDay.set(d, (byDay.get(d) ?? 0) + v);
  }
  const dayTotals = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const total = dayTotals.reduce((s, [, v]) => s + v, 0);
  w(`  ${byDay.size} distinct days carry ${events.length} events; total fade ${fmt(total, 0)} bps`);
  const top = [1, 3, 5, 10, 20];
  for (const k of top) {
    const share = dayTotals.slice(0, k).reduce((s, [, v]) => s + v, 0);
    w(`  top ${pad(k, 2)} days: ${pad(fmt(share, 0), 9)} bps  ` +
      `${total > 0 ? ((share / total) * 100).toFixed(0) + "% of the total" : ""}`);
  }
  w();
  w("  best days");
  for (const [d, v] of dayTotals.slice(0, 8)) {
    w(`    ${toISO(d * 86_400).slice(0, 10)}  ${pad(fmt(v, 0), 8)} bps`);
  }
  w();

  const text = out.join("\n");
  process.stdout.write(`${text}\n`);

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      window: { fromSec: cache.fromSec, toSec: cache.toSec },
      symbols: cache.coverage,
      simultaneity: clusterTables.map((t) => ({ windowMin: t.min, ...t.report })),
      effects,
      reproducibility: { all, original, outside },
    }, null, 2));
    process.stderr.write(`report json: ${jsonOut}\n`);
  }
}

function avg(x: readonly number[]): number {
  const v = x.filter((n) => Number.isFinite(n));
  if (v.length === 0) return Number.NaN;
  return v.reduce((s, n) => s + n, 0) / v.length;
}

function spearman(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return Number.NaN;
  const rank = (x: readonly number[]): number[] => {
    const idx = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(x.length);
    for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const ra = rank(a.slice(0, n));
  const rb = rank(b.slice(0, n));
  const ma = avg(ra);
  const mb = avg(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : Number.NaN;
}

main();
