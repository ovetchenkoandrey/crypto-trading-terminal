import fs from "node:fs";
import path from "node:path";
import { reportsDir, resolveDataRoot } from "../src/lib/data/paths.ts";
import { toISO } from "../src/lib/data/months.ts";
import {
  DEFAULT_PORTFOLIO_PARAMS,
  runPortfolio,
  type PortfolioParams,
  type PortfolioResult,
} from "../src/lib/bots/cascadePortfolio.ts";
import { clusterEvents, type CascadeEvent } from "../src/lib/bots/cascadeCrossSection.ts";
import { deflatedSharpe, sharpeOf } from "../src/lib/backtest/multipleTesting.ts";

/**
 * Portfolio runs over the event cache produced by `cascade:xsec`.
 *
 * Four stages, in the order `strategy-search.md` demands and no other:
 *
 *  1. diagnostics — zero costs and full costs on the same configuration, which
 *     separates "no edge" from "edge eaten by execution" before any parameter is
 *     touched;
 *  2. a parameter scan on in-sample only, with every combination counted so the
 *     survivor can be discounted for the number of tries;
 *  3. walk-forward, so the parameters a fold trades with were chosen on data
 *     strictly before that fold;
 *  4. stress, where the book evaporates — the regime the cost model was never
 *     calibrated on and the only one this hypothesis actually trades in.
 *
 * The out-of-sample window is refused unless `--oos` is passed, so it cannot be
 * consumed by accident during the search.
 */

const USAGE = `
Usage:
  npm run cascade:portfolio -- --cache <events.json> --stage diagnose
  npm run cascade:portfolio -- --cache <events.json> --stage scan
  npm run cascade:portfolio -- --cache <events.json> --stage walkforward
  npm run cascade:portfolio -- --cache <events.json> --stage stress
  npm run cascade:portfolio -- --cache <events.json> --stage oos --oos --params '{"holdBars":60}'

  --cache <path>       event cache from cascade:xsec (required)
  --stage <name>       diagnose | scan | walkforward | stress | oos  (default: diagnose)
  --is-end <date>      last in-sample day, inclusive (default: 2024-12-31)
  --oos                allow the run to read past --is-end
  --params <json>      portfolio parameter overrides
  --folds <n>          walk-forward folds (default: 6)
  --flush-min <n>      keep only events whose 5-minute flush holds >= n symbols
  --flush-max <n>      ... and <= n. Together they separate the isolated cascade
                       from the market-wide one, which is the question breadth
                       actually turns on.
  --data-dir <path>    dataset root
  --out <path>         write the report here as well as to stdout
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

function dayEnd(raw: string): number {
  const [y, m, d] = raw.split("-").map(Number);
  if (!y || !m || !d) fail(`--is-end must be YYYY-MM-DD`);
  return Date.UTC(y, m - 1, d + 1) / 1000 - 1;
}

interface EventCache {
  fromSec: number;
  toSec: number;
  percentile: number;
  warmupBars: number;
  cooldownBars: number;
  holdCap: number;
  events: CascadeEvent[];
  coverage: { symbol: string; bars: number; firstTime: number; lastTime: number; events: number }[];
}

/* ── cost bundles ─────────────────────────────────────────────────────────── */

const COSTS = {
  none:  { feeBpsPerSide: 0,   slippageBpsPerSide: 0,    stressEntryBps: 0,  stressExitBps: 0,  fillBandBps: 0 },
  fees:  { feeBpsPerSide: 5.5, slippageBpsPerSide: 0,    stressEntryBps: 0,  stressExitBps: 0,  fillBandBps: 0 },
  // Calibrated slippage on BTC/ETH for a 200 USDT market order is 0.0063 bps.
  // One basis point per side across a universe that includes 5M-a-day alts is
  // already generous by a wide margin on a calm day.
  full:  { feeBpsPerSide: 5.5, slippageBpsPerSide: 1,    stressEntryBps: 0,  stressExitBps: 0,  fillBandBps: 0 },
  // The book evaporates: the calibration was done on quiet days and says
  // nothing about the minute after a cascade. 25 bps a side is the low end of
  // what the 10.10.2025 reference implies; 50 is the honest middle.
  stress25: { feeBpsPerSide: 5.5, slippageBpsPerSide: 1, stressEntryBps: 25, stressExitBps: 10, fillBandBps: 0 },
  stress50: { feeBpsPerSide: 5.5, slippageBpsPerSide: 1, stressEntryBps: 50, stressExitBps: 20, fillBandBps: 0 },
  // Same as stress50 but the fill has to have been reachable inside the entry
  // bar's own range, which is the part that turns "expensive" into "absent".
  vanish:   { feeBpsPerSide: 5.5, slippageBpsPerSide: 1, stressEntryBps: 50, stressExitBps: 20, fillBandBps: 0.000001 },
} as const;

type CostName = keyof typeof COSTS;

/* ── formatting ───────────────────────────────────────────────────────────── */

function pad(s: string | number, n: number): string { return String(s).padStart(n); }
function padR(s: string | number, n: number): string { return String(s).padEnd(n); }
function fmt(v: number, d = 2): string { return Number.isFinite(v) ? v.toFixed(d) : "—"; }

function headerLine(): string {
  return "  " + padR("run", 26) + pad("trades", 8) + pad("t/day", 8) + pad("PF", 7) +
    pad("win%", 7) + pad("gross", 9) + pad("net bps", 9) + pad("t", 7) + pad("t clust", 9) +
    pad("ret%", 9) + pad("maxDD%", 8) + pad("top day", 9);
}

function resultLine(name: string, r: PortfolioResult): string {
  return "  " + padR(name, 26) + pad(r.trades.length, 8) + pad(fmt(r.tradesPerDay), 8) +
    pad(fmt(r.profitFactor), 7) + pad(fmt(r.winRate * 100, 0), 7) + pad(fmt(r.grossEdgeBps, 1), 9) +
    pad(fmt(r.netEdgeBps, 1), 9) + pad(fmt(r.netEdgeT), 7) + pad(fmt(r.netEdgeClusterT), 9) +
    pad(fmt(r.returnPct, 1), 9) + pad(fmt(r.maxDrawdownPct, 1), 8) + pad(fmt(r.topDayShare, 2), 9);
}

/* ── main ─────────────────────────────────────────────────────────────────── */

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const cacheFile = arg(argv, "cache") ?? path.join(reportsDir(dataRoot), "cascade-events-2022-01-01_2026-08-31.json");
  if (!fs.existsSync(cacheFile)) fail(`no event cache at ${cacheFile} — run cascade:xsec first`);
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as EventCache;

  const stage = arg(argv, "stage") ?? "diagnose";
  const isEnd = dayEnd(arg(argv, "is-end") ?? "2024-12-31");
  const allowOos = argv.includes("--oos");
  const overrides = JSON.parse(arg(argv, "params") ?? "{}") as Partial<PortfolioParams>;
  const folds = Number(arg(argv, "folds") ?? 6);

  const flushMin = arg(argv, "flush-min") === undefined ? 0 : Number(arg(argv, "flush-min"));
  const flushMax = arg(argv, "flush-max") === undefined ? Infinity : Number(arg(argv, "flush-max"));
  const kept = flushFilter(cache.events, flushMin, flushMax);

  const inSample = kept.filter((e) => e.time <= isEnd);
  const outSample = kept.filter((e) => e.time > isEnd);

  const out: string[] = [];
  const w = (s = "") => out.push(s);

  w("=".repeat(112));
  w(`CASCADE PORTFOLIO — stage: ${stage}`);
  w("=".repeat(112));
  w(`cache      ${cacheFile}`);
  w(`events     ${cache.events.length} total; in-sample ${inSample.length} ` +
    `(.. ${toISO(isEnd).slice(0, 10)}), out-of-sample ${outSample.length}`);
  w(`symbols    ${cache.coverage.length}`);
  if (flushMin > 0 || Number.isFinite(flushMax)) {
    w(`flush size ${flushMin}..${Number.isFinite(flushMax) ? flushMax : "inf"} symbols per 5-minute flush ` +
      `(${kept.length} of ${cache.events.length} events kept)`);
  }
  w();

  if (stage === "diagnose") diagnose(w, inSample, overrides);
  else if (stage === "scan") scan(w, inSample, overrides);
  else if (stage === "walkforward") walkforward(w, inSample, overrides, folds);
  else if (stage === "stress") stress(w, inSample, overrides);
  else if (stage === "oos") {
    if (!allowOos) fail("stage oos needs --oos, spelled out, so it cannot happen by accident");
    oos(w, inSample, outSample, overrides);
  } else fail(`unknown stage "${stage}"`);

  const text = out.join("\n");
  process.stdout.write(`${text}\n`);
  const outFile = arg(argv, "out");
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${text}\n`);
    process.stderr.write(`written: ${outFile}\n`);
  }
}

/* ── stage 1: diagnostics ─────────────────────────────────────────────────── */

function diagnose(w: (s?: string) => void, events: CascadeEvent[], over: Partial<PortfolioParams>): void {
  w("1. DIAGNOSTICS — same configuration, three cost levels");
  w("-".repeat(112));
  w(headerLine());
  const base: Partial<PortfolioParams> = { ...DEFAULT_PORTFOLIO_PARAMS, ...over };
  for (const name of ["none", "fees", "full"] as CostName[]) {
    w(resultLine(`costs: ${name}`, runPortfolio(events, { ...base, ...COSTS[name] })));
  }
  w();

  w("  concurrency — how much of the signal a 1000 USDT account can hold at once");
  w(headerLine());
  for (const maxConcurrent of [1, 2, 3, 5, 8, 12, 20]) {
    const notionalPct = Math.min(50, 100 / maxConcurrent);
    const r = runPortfolio(events, { ...base, ...COSTS.none, maxConcurrent, notionalPct });
    w(resultLine(`slots ${maxConcurrent} @ ${notionalPct.toFixed(0)}% each`, r));
  }
  w();

  w("  hold horizon, zero costs");
  w(headerLine());
  for (const holdBars of [1, 5, 15, 30, 60, 120]) {
    w(resultLine(`hold ${holdBars}m`, runPortfolio(events, { ...base, ...COSTS.none, holdBars })));
  }
  w();

  w("  direction split, zero costs (a rising market flatters the long leg)");
  w(headerLine());
  w(resultLine("longs only", runPortfolio(events, { ...base, ...COSTS.none, allowShort: false })));
  w(resultLine("shorts only", runPortfolio(events, { ...base, ...COSTS.none, allowLong: false })));
  w();

  w("  mirror test — following the move instead of fading it should lose what fading wins");
  w(headerLine());
  const mirrored = events.map((e) => ({ ...e, moveBps: -e.moveBps }));
  w(resultLine("fade (the strategy)", runPortfolio(events, { ...base, ...COSTS.none })));
  w(resultLine("follow (the mirror)", runPortfolio(mirrored, { ...base, ...COSTS.none })));
  w();

  const r = runPortfolio(events, { ...base, ...COSTS.none });
  w("  skip reasons at zero costs: " +
    Object.entries(r.skips).map(([k, v]) => `${k} ${v}`).join(", "));
  w();
}

/* ── stage 2: parameter scan ──────────────────────────────────────────────── */

interface ScanRow {
  label: string;
  params: Partial<PortfolioParams>;
  free: PortfolioResult;
  paid: PortfolioResult;
}

const SCAN_GRID = {
  holdBars: [15, 30, 60, 120],
  maxConcurrent: [3, 5, 8],
  minMoveBps: [0, 150, 250],
  burstRule: ["biggest", "first", "smallest"] as const,
};

function scan(w: (s?: string) => void, events: CascadeEvent[], over: Partial<PortfolioParams>): void {
  const rows: ScanRow[] = [];
  for (const holdBars of SCAN_GRID.holdBars) {
    for (const maxConcurrent of SCAN_GRID.maxConcurrent) {
      for (const minMoveBps of SCAN_GRID.minMoveBps) {
        for (const burstRule of SCAN_GRID.burstRule) {
          const params: Partial<PortfolioParams> = {
            ...DEFAULT_PORTFOLIO_PARAMS, ...over,
            holdBars, maxConcurrent, minMoveBps, burstRule,
            notionalPct: Math.min(50, 100 / maxConcurrent),
          };
          rows.push({
            label: `h${holdBars} c${maxConcurrent} m${minMoveBps} ${burstRule}`,
            params,
            free: runPortfolio(events, { ...params, ...COSTS.none }),
            paid: runPortfolio(events, { ...params, ...COSTS.full }),
          });
        }
      }
    }
  }

  w(`2. PARAMETER SCAN — ${rows.length} combinations, in-sample only`);
  w("-".repeat(112));
  w();
  w("  top 15 by net profit factor with full costs");
  w(headerLine());
  for (const row of [...rows].sort((a, b) => b.paid.profitFactor - a.paid.profitFactor).slice(0, 15)) {
    w(resultLine(row.label, row.paid));
  }
  w();
  w("  top 10 by profit factor with zero costs — is there an edge before execution at all?");
  w(headerLine());
  for (const row of [...rows].sort((a, b) => b.free.profitFactor - a.free.profitFactor).slice(0, 10)) {
    w(resultLine(row.label, row.free));
  }
  w();

  const paidPfs = rows.map((r) => r.paid.profitFactor).filter(Number.isFinite);
  const positive = rows.filter((r) => r.paid.profitFactor > 1).length;
  w(`  combinations profitable after full costs: ${positive} / ${rows.length}`);
  w(`  median PF (full costs): ${fmt(median(paidPfs))}, best ${fmt(Math.max(...paidPfs))}`);
  w();

  const best = [...rows].sort((a, b) => b.paid.netEdgeClusterT - a.paid.netEdgeClusterT)[0];
  w(`  best by clustered t: ${best.label}, t = ${fmt(best.paid.netEdgeClusterT)} on ` +
    `${best.paid.netEdgeClusters} flushes (${best.paid.trades.length} trades)`);
  w(`  expected max |z| from ${rows.length} pure-noise draws: ${fmt(expectedMaxAbsZ(rows.length))}`);
  w(`  verdict: ${best.paid.netEdgeClusterT > expectedMaxAbsZ(rows.length)
    ? "above what the search alone would produce"
    : "indistinguishable from the best of that many coin flips"}`);
  w();
}

/* ── stage 3: walk-forward ────────────────────────────────────────────────── */

function walkforward(
  w: (s?: string) => void,
  events: CascadeEvent[],
  over: Partial<PortfolioParams>,
  folds: number,
): void {
  if (events.length === 0) fail("no in-sample events");
  const first = Math.min(...events.map((e) => e.time));
  const last = Math.max(...events.map((e) => e.time));
  const span = last - first;
  const testLen = span / (folds + 1);

  w(`3. WALK-FORWARD — ${folds} folds, parameters fitted on everything before each fold`);
  w("-".repeat(112));
  w();

  const grid: Partial<PortfolioParams>[] = [];
  for (const holdBars of SCAN_GRID.holdBars) {
    for (const maxConcurrent of SCAN_GRID.maxConcurrent) {
      for (const minMoveBps of SCAN_GRID.minMoveBps) {
        grid.push({
          holdBars, maxConcurrent, minMoveBps,
          notionalPct: Math.min(50, 100 / maxConcurrent),
        });
      }
    }
  }

  const stitched: number[] = [];
  const stitchedFlushes: { time: number; bps: number }[] = [];
  const trialSharpes: number[] = [];
  let equity = DEFAULT_PORTFOLIO_PARAMS.initialEquity;

  w("  " + padR("fold", 6) + padR("train", 24) + padR("test", 24) +
    pad("chosen", 20) + pad("trades", 8) + pad("PF", 7) + pad("net bps", 9) +
    pad("t clust", 9) + pad("ret%", 9));
  for (let f = 0; f < folds; f++) {
    const trainEnd = first + testLen * (f + 1);
    const testEnd = trainEnd + testLen;
    const train = events.filter((e) => e.time < trainEnd);
    const test = events.filter((e) => e.time >= trainEnd && e.time < testEnd);
    if (train.length < 20 || test.length === 0) {
      w("  " + padR(f + 1, 6) + "too few events — skipped");
      continue;
    }

    let best: { p: Partial<PortfolioParams>; r: PortfolioResult } | null = null;
    for (const p of grid) {
      const r = runPortfolio(train, { ...DEFAULT_PORTFOLIO_PARAMS, ...over, ...p, ...COSTS.full });
      if (r.trades.length < 10) continue;
      trialSharpes.push(tradeSharpe(r));
      if (best === null || r.profitFactor > best.r.profitFactor) best = { p, r };
    }
    if (best === null) {
      w("  " + padR(f + 1, 6) + "no trainable configuration — skipped");
      continue;
    }

    const tested = runPortfolio(test, {
      ...DEFAULT_PORTFOLIO_PARAMS, ...over, ...best.p, ...COSTS.full, initialEquity: equity,
    });
    equity = tested.equity;
    for (const t of tested.trades) {
      if (t.notional > 0) {
        stitched.push(t.pnl / t.notional);
        stitchedFlushes.push({ time: t.entryTime, bps: (t.pnl / t.notional) * 1e4 });
      }
    }

    const chosen = `h${best.p.holdBars} c${best.p.maxConcurrent} m${best.p.minMoveBps}`;
    w("  " + padR(f + 1, 6) +
      padR(`${toISO(first).slice(0, 10)}..${toISO(trainEnd).slice(0, 10)}`, 24) +
      padR(`${toISO(trainEnd).slice(0, 10)}..${toISO(testEnd).slice(0, 10)}`, 24) +
      pad(chosen, 20) + pad(tested.trades.length, 8) + pad(fmt(tested.profitFactor), 7) +
      pad(fmt(tested.netEdgeBps, 1), 9) + pad(fmt(tested.netEdgeClusterT), 9) +
      pad(fmt(tested.returnPct, 1), 9));
  }

  w();
  if (stitched.length < 5) {
    w("  stitched track too short to score");
    return;
  }

  // The unit of independence is a flush, not a trade: forty positions opened in
  // one market-wide minute are one bet. Both are reported so the size of the
  // difference is visible rather than assumed.
  const flushes = collapseFlushes(stitchedFlushes);
  const perTrade = stitched.map((v) => v);
  const perFlush = flushes.map((v) => v / 1e4);

  const totalPct = ((equity - DEFAULT_PORTFOLIO_PARAMS.initialEquity) / DEFAULT_PORTFOLIO_PARAMS.initialEquity) * 100;
  const wins = stitched.filter((v) => v > 0).length;
  const grossWin = stitched.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = -stitched.filter((v) => v <= 0).reduce((s, v) => s + v, 0);
  w(`  stitched out-of-fold track: ${stitched.length} trades in ${flushes.length} flushes, ` +
    `${fmt((wins / stitched.length) * 100, 0)}% winners, PF ${fmt(grossLoss > 0 ? grossWin / grossLoss : Infinity)}`);
  w(`  equity ${fmt(equity, 2)} from ${DEFAULT_PORTFOLIO_PARAMS.initialEquity} (${fmt(totalPct, 1)}%)`);

  for (const [label, sample] of [["per trade", perTrade], ["per flush", perFlush]] as const) {
    const sharpe = sharpeOf(sample);
    const m = moments(sample);
    const ds = deflatedSharpe({
      sharpe,
      observations: sample.length,
      skew: m.skew,
      kurtosis: m.kurtosis,
      trialSharpes,
      trials: grid.length * folds,
    });
    const t = sharpe * Math.sqrt(sample.length);
    w(`  ${padR(label, 10)} n ${pad(sample.length, 5)}  Sharpe ${fmt(sharpe, 4)}  t ${fmt(t, 2)}  ` +
      `DSR threshold ${fmt(ds.threshold, 4)}  DSR ${fmt(ds.dsr, 3)}  ` +
      `${ds.dsr > 0.95 ? "SURVIVES" : "rejected"}`);
  }
  w(`  trials counted: ${grid.length} configurations x ${folds} folds`);
  w();
}

/** Mean net bps per market-wide flush over a stitched trade list. */
function collapseFlushes(rows: readonly { time: number; bps: number }[]): number[] {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const out: number[] = [];
  let bucket: number[] = [];
  let last = -Infinity;
  for (const r of sorted) {
    if (bucket.length > 0 && r.time - last > 300) {
      out.push(bucket.reduce((s, v) => s + v, 0) / bucket.length);
      bucket = [];
    }
    bucket.push(r.bps);
    last = r.time;
  }
  if (bucket.length > 0) out.push(bucket.reduce((s, v) => s + v, 0) / bucket.length);
  return out;
}

function tradeSharpe(r: PortfolioResult): number {
  const vals = r.trades.filter((t) => t.notional > 0).map((t) => t.pnl / t.notional);
  return sharpeOf(vals);
}

/* ── stage 4: stress ──────────────────────────────────────────────────────── */

function stress(w: (s?: string) => void, events: CascadeEvent[], over: Partial<PortfolioParams>): void {
  w("4. STRESS — the book evaporates, which is the only regime this strategy trades in");
  w("-".repeat(112));
  w(headerLine());
  const base: Partial<PortfolioParams> = { ...DEFAULT_PORTFOLIO_PARAMS, ...over };
  for (const name of ["none", "fees", "full", "stress25", "stress50", "vanish"] as CostName[]) {
    w(resultLine(name, runPortfolio(events, { ...base, ...COSTS[name] })));
  }
  w();
  w("  breakeven search — how much slippage per side the edge can absorb");
  w("  " + padR("slippage/side", 16) + pad("trades", 8) + pad("PF", 8) + pad("net bps", 10) + pad("ret%", 9));
  for (const bps of [0, 2, 5, 10, 15, 20, 30, 50]) {
    const r = runPortfolio(events, { ...base, feeBpsPerSide: 5.5, slippageBpsPerSide: bps });
    w("  " + padR(`${bps} bps`, 16) + pad(r.trades.length, 8) + pad(fmt(r.profitFactor), 8) +
      pad(fmt(r.netEdgeBps, 1), 10) + pad(fmt(r.returnPct, 1), 9));
  }
  w();
  const vanished = runPortfolio(events, { ...base, ...COSTS.vanish });
  w(`  under 'vanish', ${vanished.skips.noFill} entries never happen because the price they need ` +
    `was outside the entry bar's own range`);
  w();
}

/* ── stage 5: out of sample ───────────────────────────────────────────────── */

function oos(
  w: (s?: string) => void,
  inSample: CascadeEvent[],
  outSample: CascadeEvent[],
  over: Partial<PortfolioParams>,
): void {
  w("5. OUT OF SAMPLE — fixed parameters, no fitting, first and only look");
  w("-".repeat(112));
  const base: Partial<PortfolioParams> = { ...DEFAULT_PORTFOLIO_PARAMS, ...over };
  w(`  parameters: ${JSON.stringify(over)}`);
  w();
  w(headerLine());
  for (const name of ["none", "fees", "full", "stress25", "stress50"] as CostName[]) {
    w(resultLine(`IS  ${name}`, runPortfolio(inSample, { ...base, ...COSTS[name] })));
  }
  w();
  for (const name of ["none", "fees", "full", "stress25", "stress50"] as CostName[]) {
    w(resultLine(`OOS ${name}`, runPortfolio(outSample, { ...base, ...COSTS[name] })));
  }
  w();
}

/* ── small statistics ─────────────────────────────────────────────────────── */

/**
 * Keeps events whose market-wide flush holds a symbol count in [min, max].
 * The flush is recomputed on the unfiltered stream, so a filter never changes
 * what counts as simultaneous.
 */
function flushFilter(events: readonly CascadeEvent[], min: number, max: number): CascadeEvent[] {
  if (min <= 0 && !Number.isFinite(max)) return [...events];
  const out: CascadeEvent[] = [];
  for (const c of clusterEvents(events, 300)) {
    const size = c.symbols.length;
    if (size >= min && size <= max) out.push(...c.events);
  }
  return out.sort((a, b) => a.time - b.time);
}

function median(x: readonly number[]): number {
  if (x.length === 0) return Number.NaN;
  const s = [...x].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function moments(x: readonly number[]): { skew: number; kurtosis: number } {
  const n = x.length;
  const m = x.reduce((s, v) => s + v, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of x) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return { skew: sd > 0 ? m3 / (sd ** 3) : 0, kurtosis: sd > 0 ? m4 / (m2 * m2) : 3 };
}

/** Expected maximum |z| over m independent standard normals — the noise ceiling. */
function expectedMaxAbsZ(m: number): number {
  if (m <= 1) return 0;
  const lg = Math.log(m);
  return Math.sqrt(2 * lg) - (Math.log(lg) + Math.log(4 * Math.PI)) / (2 * Math.sqrt(2 * lg)) +
    0.5772156649 / Math.sqrt(2 * lg);
}

main();
