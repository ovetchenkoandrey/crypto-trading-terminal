import fs from "node:fs";
import path from "node:path";
import { intervalSeconds, type DataInterval, isDataInterval } from "../src/lib/data/interval.ts";
import { fitLot, interpolateCostBps, type LotSpec } from "../src/lib/data/liquidityProfile.ts";
import { createMetricsStore } from "../src/lib/data/metricsStore.ts";
import { reportsDir, resolveDataRoot, type Market } from "../src/lib/data/paths.ts";
import { CASCADE_UNIVERSE, universeSymbol } from "../src/lib/data/universe.ts";
import {
  breakevenCostScale,
  costVector,
  runLiquidityFactor,
  runLiquiditySleeves,
  type LiquidityFactorParams,
} from "../src/lib/bots/factorLiquidity.ts";
import type { FactorInput } from "../src/lib/bots/positioningFactor.ts";
import { buildPanel, crossSectionalSpread, type Panel, type PanelSeries } from "../src/lib/research/crossSection.ts";
import { forwardReturns } from "../src/lib/research/infoCoefficient.ts";
import { asOfSeries, buildPositioningSeries } from "../src/lib/research/positioningFeatures.ts";
import { loadFrames } from "../src/lib/research/screening.ts";

/**
 * Does `pos_tt_pos_level` survive the book it would actually trade?
 *
 *   npm run factor:liquidity -- --from 2025-01-01 --to 2026-08-26
 *
 * Section 14 of positioning-data.md ends on an explicit debt: the factor's
 * 27% a year is measured against 5.5 basis points a side, and that number was
 * calibrated on BTCUSDT. This run replaces the constant with the per-symbol
 * cost measured by `npm run measure:liquidity`, then asks the three questions
 * that follow from a 1000 USDT account — which names it can hold at all, what
 * rounding does to the weights, and where in the liquidity spectrum the effect
 * actually lives.
 *
 * Nothing here re-fits the signal. The feature, the side, the rebalance period
 * and the sample split are those already written down; only the cost model and
 * the tradable set change.
 */

const USAGE = `
Usage: npm run factor:liquidity -- --from 2025-01-01 --to 2026-08-26

  --feature <name>       default: pos_tt_pos_level
  --from <when>          YYYY-MM | YYYY-MM-DD (default: 2025-01-01)
  --to <when>            default: 2026-08-26
  --timeframe <tf>       default: 1h
  --horizon <bars>       forward horizon for the cross-section (default: 96)
  --rebalance <bars>     book rebalance period (default: 96)
  --side <frac>          share of the board per side (default: 0.2)
  --min-symbols <n>      breadth required per date (default: 10)
  --fee <bps>            taker fee per side (default: 5.5)
  --deposits <list>      account sizes in USDT (default: 1000,10000,100000)
  --headline <usdt>      deposit the per-symbol cost vector is priced at (default: 1000)
  --gross <x>            gross exposure as a multiple of the deposit (default: 2)
  --liquidity <path>     measure:liquidity report (default: <data>/reports/liquidity/universe.json)
  --deep <path>          optional book_snapshot_25 report, used to bound the
                         five-level truncation
  --market <name>        linear | spot (default: linear)
  --data-dir <path>
  --out <path>           default: <data-dir>/reports/liquidity
  --tag <name>           default: factor
  --no-write
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

/* ── the measured cost table ──────────────────────────────────────────────── */

interface MeasuredSymbol {
  symbol: string;
  sizes: number[];
  costBps: number[];
  unfilledFrac: number[];
  spreadBpsMean: number;
  spreadBpsMedian: number;
  spreadBpsP99: number;
  topUsdt: number;
  depthVisibleUsdt: number;
  days: number;
  midPrice: number;
  /** Median across sampled days of the +-1% band notional. */
  band1Usdt: number;
  worstBand1Usdt: number;
  worstBandDate: string;
}

function readMeasurements(file: string): Map<string, MeasuredSymbol> {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    reports: {
      symbol: string;
      days: unknown[];
      combined: {
        spreadBpsMean: number;
        spreadBpsMedian: number;
        spreadBpsP99: number;
        topUsdt: number;
        depthVisibleUsdt: number;
        midPrice: number;
        sizes: { notionalUsdt: number; costBpsMean: number; unfilledFrac: number }[];
      } | null;
      depth: { date: string; medianBand1Usdt: number; minBand1Usdt: number }[];
    }[];
  };
  const out = new Map<string, MeasuredSymbol>();
  for (const r of raw.reports) {
    if (!r.combined) continue;
    const meds = r.depth.map((d) => d.medianBand1Usdt).sort((a, b) => a - b);
    let worst = r.depth[0];
    for (const d of r.depth) if (d.minBand1Usdt < worst.minBand1Usdt) worst = d;
    out.set(r.symbol, {
      symbol: r.symbol,
      sizes: r.combined.sizes.map((s) => s.notionalUsdt),
      costBps: r.combined.sizes.map((s) => s.costBpsMean),
      unfilledFrac: r.combined.sizes.map((s) => s.unfilledFrac),
      spreadBpsMean: r.combined.spreadBpsMean,
      spreadBpsMedian: r.combined.spreadBpsMedian,
      spreadBpsP99: r.combined.spreadBpsP99,
      topUsdt: r.combined.topUsdt,
      depthVisibleUsdt: r.combined.depthVisibleUsdt,
      midPrice: r.combined.midPrice,
      days: r.days.length,
      band1Usdt: meds.length > 0 ? meds[Math.floor(meds.length / 2)] : Number.NaN,
      worstBand1Usdt: worst ? worst.minBand1Usdt : Number.NaN,
      worstBandDate: worst ? worst.date : "",
    });
  }
  return out;
}

/* ── panel ────────────────────────────────────────────────────────────────── */

interface SymbolFrames {
  symbol: string;
  time: Float64Array;
  close: Float64Array;
  feature: Float64Array;
  forward: Float64Array;
}

function loadSymbol(
  dataRoot: string,
  market: Market,
  symbol: string,
  fromSec: number,
  toSec: number,
  tf: DataInterval,
  horizon: number,
  feature: string,
): SymbolFrames | null {
  const store = createMetricsStore(dataRoot);
  const rows = store.readRange(symbol, fromSec, toSec);
  if (rows.length === 0) return null;
  const set = buildPositioningSeries(rows);
  const frames = loadFrames(dataRoot, market, symbol, fromSec, toSec, [tf]);
  const bars = frames.bars.get(tf) ?? [];
  if (bars.length < 500) return null;
  const values = set.byName.get(feature);
  if (!values) fail(`unknown positioning feature "${feature}"`);
  const series = asOfSeries(set.grid, values, bars);
  const fwd = forwardReturns(bars, horizon, intervalSeconds(tf));
  // Simple returns, as in section 14.9: over ninety-six hours the log/simple gap
  // is the same order as the effect.
  for (let i = 0; i < fwd.length; i++) fwd[i] = Math.expm1(fwd[i]);
  return {
    symbol,
    time: Float64Array.from(bars, (b) => b.time),
    close: Float64Array.from(bars, (b) => b.close),
    feature: Float64Array.from(series, (v) => (v === null ? Number.NaN : v)),
    forward: fwd,
  };
}

function alignToPanel(panel: Panel, frames: SymbolFrames, values: Float64Array): Float64Array {
  const out = new Float64Array(panel.times.length).fill(Number.NaN);
  let at = 0;
  for (let i = 0; i < frames.time.length; i++) {
    while (at < panel.times.length && panel.times[at] < frames.time[i]) at++;
    if (at >= panel.times.length) break;
    if (panel.times[at] === frames.time[i]) out[at] = values[i];
  }
  return out;
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (flag(argv, "help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const dataRoot = resolveDataRoot(arg(argv, "data-dir"));
  const feature = arg(argv, "feature") ?? "pos_tt_pos_level";
  const fromSec = parseWhen(arg(argv, "from") ?? "2025-01-01", false);
  const toSec = parseWhen(arg(argv, "to") ?? "2026-08-26", true);
  const tfRaw = arg(argv, "timeframe") ?? "1h";
  if (!isDataInterval(tfRaw)) fail(`unknown timeframe "${tfRaw}"`);
  const tf = tfRaw;
  const horizon = Number(arg(argv, "horizon") ?? 96);
  const rebalance = Number(arg(argv, "rebalance") ?? 96);
  const side = Number(arg(argv, "side") ?? 0.2);
  const minSymbols = Number(arg(argv, "min-symbols") ?? 10);
  const feeBps = Number(arg(argv, "fee") ?? 5.5);
  const deposits = (arg(argv, "deposits") ?? "1000,10000,100000").split(",").map(Number);
  const gross = Number(arg(argv, "gross") ?? 2);
  const headlineDeposit = Number(arg(argv, "headline") ?? 1000);
  const market = (arg(argv, "market") ?? "linear") as Market;
  const liquidityFile = arg(argv, "liquidity") ?? path.join(reportsDir(dataRoot), "liquidity", "universe.json");
  const deepFile = arg(argv, "deep");
  const outDir = arg(argv, "out") ?? path.join(reportsDir(dataRoot), "liquidity");
  const tag = arg(argv, "tag") ?? "factor";
  const write = !flag(argv, "no-write");

  if (!fs.existsSync(liquidityFile)) fail(`no liquidity report at ${liquidityFile} — run npm run measure:liquidity first`);
  const measured = readMeasurements(liquidityFile);
  const deep = deepFile && fs.existsSync(deepFile) ? readMeasurements(deepFile) : null;

  const loaded: SymbolFrames[] = [];
  for (const spec of CASCADE_UNIVERSE) {
    const f = loadSymbol(dataRoot, market, spec.symbol, fromSec, toSec, tf, horizon, feature);
    if (f) loaded.push(f);
  }
  if (loaded.length < minSymbols) fail(`only ${loaded.length} symbols have data in this window`);

  const panel = buildPanel(
    loaded.map<PanelSeries>((s) => ({ symbol: s.symbol, time: s.time, feature: s.feature, forward: s.forward })),
  );
  const closes = panel.symbols.map((sym) => {
    const f = loaded.find((l) => l.symbol === sym)!;
    return alignToPanel(panel, f, f.close);
  });
  const input: FactorInput = {
    symbols: panel.symbols,
    times: Float64Array.from(panel.times),
    feature: panel.feature.map((f) => Float64Array.from(f)),
    close: closes,
  };
  const n = input.symbols.length;

  const lines: string[] = [];
  const json: Record<string, unknown> = {
    feature,
    from: new Date(fromSec * 1000).toISOString(),
    to: new Date(toSec * 1000).toISOString(),
    timeframe: tf,
    horizon,
    rebalance,
    side,
    feeBps,
    gross,
    deposits,
    symbols: input.symbols,
  };
  lines.push(`factor under measured liquidity — ${feature} ${tf} h${horizon} R=${rebalance} side ${side}`);
  lines.push(
    `span ${new Date(fromSec * 1000).toISOString().slice(0, 10)} .. ${new Date(toSec * 1000).toISOString().slice(0, 10)}` +
      `  symbols ${n}  fee ${feeBps} bp/side  gross ${gross}x`,
  );
  lines.push("");

  /* per-name notional at each deposit, and the cost that comes with it */

  const namesPerSide = Math.max(1, Math.round(n * Math.min(0.5, Math.max(0.02, side))));
  const namesHeld = namesPerSide * 2;
  lines.push(
    `basket: ${namesPerSide} names a side, ${namesHeld} positions; at gross ${gross}x a ` +
      `${deposits[0]} USDT account puts ${num((deposits[0] * gross) / namesHeld, 1)} USDT into each`,
  );
  lines.push("");

  const missing = input.symbols.filter((s) => !measured.has(s));
  if (missing.length > 0) {
    lines.push(`no book sample for ${missing.length} symbols, charged fee only: ${missing.join(",")}`);
    lines.push("");
  }

  const slipAt = (notionalPerName: number): Map<string, number> => {
    const m = new Map<string, number>();
    for (const sym of input.symbols) {
      const mm = measured.get(sym);
      if (!mm) continue;
      m.set(sym, interpolateCostBps(mm.sizes, mm.costBps, notionalPerName));
    }
    return m;
  };

  const lots: (LotSpec | null)[] = input.symbols.map((sym) => {
    const u = universeSymbol(sym);
    return u ? { minQty: u.minQty, qtyStep: u.qtyStep, minNotionalUsdt: u.minNotionalUsdt } : null;
  });

  const baseParams = (cost: Float64Array, over: Partial<LiquidityFactorParams> = {}): LiquidityFactorParams => ({
    side,
    rebalanceBars: rebalance,
    minSymbols,
    contrarian: true,
    longOnly: false,
    grossLeverage: 1,
    costBpsPerSide: cost,
    ...over,
  });

  /* ── 1. the cost swap ────────────────────────────────────────────────────── */

  const headlineNotional = (headlineDeposit * gross) / namesHeld;
  const slip = slipAt(headlineNotional);
  const scenarios: { label: string; cost: Float64Array }[] = [
    { label: `flat ${feeBps} bp (section 14)`, cost: new Float64Array(n).fill(feeBps) },
    { label: "fee + measured slippage", cost: costVector(input.symbols, feeBps, slip, 1) },
    { label: "fee + 2x measured slippage", cost: costVector(input.symbols, feeBps, slip, 2) },
    { label: "fee + 5x measured slippage", cost: costVector(input.symbols, feeBps, slip, 5) },
    { label: "zero cost", cost: new Float64Array(n) },
  ];

  lines.push("══ 1. the flat rate replaced by the measured one ══");
  lines.push(
    `  ${pad("cost model", 30)}${padLeft("net bp", 9)}${padLeft("t", 7)}${padLeft("ann %", 8)}` +
      `${padLeft("Sharpe", 8)}${padLeft("maxDD", 8)}${padLeft("cost bp", 9)}${padLeft("turnover", 10)}` +
      `${padLeft("12 sleeves", 12)}${padLeft("agree", 7)}`,
  );
  const scenarioRows: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const r = runLiquidityFactor(input, baseParams(sc.cost));
    const sl = runLiquiditySleeves(input, baseParams(sc.cost), 12);
    lines.push(
      `  ${pad(sc.label, 30)}${padLeft(num(r.netBps, 2), 9)}${padLeft(num(r.netT, 2), 7)}` +
        `${padLeft(num(r.annualReturnPct, 1), 8)}${padLeft(num(r.sharpe, 2), 8)}` +
        `${padLeft(num(r.maxDrawdown * 100, 1), 8)}${padLeft(num(r.costBps, 2), 9)}` +
        `${padLeft(num(r.meanTurnover, 2), 10)}${padLeft(num(sl.netBps, 2), 12)}${padLeft(`${sl.agree}/${sl.sleeves}`, 7)}`,
    );
    scenarioRows.push({ label: sc.label, result: { ...r, periods: undefined }, sleeves: sl });
  }
  const scale = breakevenCostScale(input, baseParams(costVector(input.symbols, 0, slip, 1)));
  lines.push("");
  lines.push(
    `  breakeven: the measured slippage vector can be multiplied by ${num(scale, 1)} before the book stops paying` +
      ` (fee excluded from the vector)`,
  );
  const feeScale = breakevenCostScale(input, baseParams(new Float64Array(n).fill(1)));
  lines.push(`  breakeven flat cost, for comparison: ${num(feeScale, 1)} bp a side`);
  json.scenarios = scenarioRows;
  json.breakevenSlippageScale = scale;
  json.breakevenFlatBps = feeScale;

  /* ── 2. what the account can actually hold ───────────────────────────────── */

  lines.push("");
  lines.push("══ 2. lot filters at each deposit ══");
  lines.push(
    `  ${pad("symbol", 14)}${padLeft("price", 12)}${padLeft("minQty $", 11)}${padLeft("step $", 10)}` +
      deposits.map((d) => padLeft(`${d}`, 11)).join(""),
  );
  const perDepositNotional = deposits.map((d) => (d * gross) / namesHeld);
  const tradableRows: Record<string, unknown>[] = [];
  const alwaysOut: string[][] = deposits.map(() => []);
  const sometimesOut: string[][] = deposits.map(() => []);
  for (let s = 0; s < n; s++) {
    const sym = input.symbols[s];
    const u = universeSymbol(sym);
    if (!u) continue;
    const lot: LotSpec = { minQty: u.minQty, qtyStep: u.qtyStep, minNotionalUsdt: u.minNotionalUsdt };
    // A price that moved by a factor of three across the window moves the
    // minimum ticket with it, so the census runs over every bar rather than
    // over the last close.
    let last = Number.NaN;
    const cells = perDepositNotional.map((target, i) => {
      let bars = 0;
      let ok = 0;
      let errSum = 0;
      for (let t = 0; t < input.close[s].length; t++) {
        const price = input.close[s][t];
        if (!(price > 0)) continue;
        bars++;
        last = price;
        const fit = fitLot(target, price, lot);
        if (fit.tradable) {
          ok++;
          errSum += fit.error;
        }
      }
      if (bars === 0) return "n/a";
      const share = ok / bars;
      if (share === 0) alwaysOut[i].push(sym);
      else if (share < 0.999) sometimesOut[i].push(`${sym}:${num(share * 100, 0)}%`);
      if (ok === 0) return "no";
      const err = (errSum / ok) * 100;
      return share >= 0.999 ? `${num(err, 1)}%` : `${num(share * 100, 0)}%/${num(err, 1)}%`;
    });
    const minTicket = Math.max(u.minQty * last, u.minNotionalUsdt);
    lines.push(
      pad(sym, 14) +
        padLeft(num(last, last < 1 ? 6 : 2), 12) +
        padLeft(num(minTicket, 1), 11) +
        padLeft(num(u.qtyStep * last, 2), 10) +
        cells.map((c) => padLeft(c, 13)).join(""),
    );
    tradableRows.push({ symbol: sym, lastPrice: last, minTicketUsdt: minTicket, stepUsdt: u.qtyStep * last, cells });
  }
  lines.push("");
  lines.push("  cells: mean rounding shortfall as a share of the slot; a leading percentage is the");
  lines.push("  share of bars where the minimum ticket fitted at all");
  for (let i = 0; i < deposits.length; i++) {
    lines.push(
      `  deposit ${padLeft(String(deposits[i]), 7)} USDT -> ${num(perDepositNotional[i], 1)} USDT a slot; ` +
        `${n - alwaysOut[i].length}/${n} symbols ever tradable` +
        (alwaysOut[i].length > 0 ? `; never: ${alwaysOut[i].join(",")}` : "") +
        (sometimesOut[i].length > 0 ? `; part-time: ${sometimesOut[i].join(" ")}` : ""),
    );
  }
  json.lotCensus = { deposits, perDepositNotional, rows: tradableRows, alwaysOut, sometimesOut };

  /* ── 3. the book actually executable at each deposit ─────────────────────── */

  lines.push("");
  lines.push("══ 3. the book a real account gets: costs at that size, weights floored to the lot ══");
  lines.push(
    `  ${pad("deposit", 10)}${padLeft("slot $", 9)}${padLeft("net bp", 9)}${padLeft("t", 7)}` +
      `${padLeft("ann %", 8)}${padLeft("Sharpe", 8)}${padLeft("maxDD", 8)}${padLeft("exposure", 10)}` +
      `${padLeft("wErrL1", 9)}${padLeft("dropped", 9)}${padLeft("sleeves", 9)}${padLeft("agree", 7)}`,
  );
  const depositRows: Record<string, unknown>[] = [];
  for (let i = 0; i < deposits.length; i++) {
    const notional = perDepositNotional[i];
    const cost = costVector(input.symbols, feeBps, slipAt(notional), 1);
    const p = baseParams(cost, { lots, bookNotionalUsdt: deposits[i] * gross });
    const r = runLiquidityFactor(input, p);
    const sl = runLiquiditySleeves(input, p, 12);
    lines.push(
      `  ${pad(String(deposits[i]), 10)}${padLeft(num(notional, 1), 9)}${padLeft(num(r.netBps, 2), 9)}` +
        `${padLeft(num(r.netT, 2), 7)}${padLeft(num(r.annualReturnPct, 1), 8)}${padLeft(num(r.sharpe, 2), 8)}` +
        `${padLeft(num(r.maxDrawdown * 100, 1), 8)}${padLeft(num(r.meanExposure, 3), 10)}` +
        `${padLeft(num(r.meanWeightErrorL1, 3), 9)}${padLeft(num(r.meanDroppedNames, 2), 9)}` +
        `${padLeft(num(sl.netBps, 2), 9)}${padLeft(`${sl.agree}/${sl.sleeves}`, 7)}`,
    );
    const stressed = runLiquidityFactor(input, baseParams(costVector(input.symbols, feeBps, slipAt(notional), 2), {
      lots,
      bookNotionalUsdt: deposits[i] * gross,
    }));
    depositRows.push({
      deposit: deposits[i],
      slotUsdt: notional,
      result: { ...r, periods: undefined },
      stressed: { ...stressed, periods: undefined },
      sleeves: sl,
    });
  }
  lines.push("");
  lines.push("  the same, with the measured slippage doubled:");
  for (const row of depositRows) {
    const st = row.stressed as { netBps: number; netT: number; annualReturnPct: number; sharpe: number };
    lines.push(
      `  ${pad(String(row.deposit), 10)}${padLeft(num(st.netBps, 2), 9)}${padLeft(num(st.netT, 2), 7)}` +
        `${padLeft(num(st.annualReturnPct, 1), 8)}${padLeft(num(st.sharpe, 2), 8)}`,
    );
  }
  json.deposits = depositRows;

  /* ── 4. where in the liquidity spectrum the effect lives ─────────────────── */

  lines.push("");
  lines.push("══ 4. liquid half against thin half ══");
  const ranked = input.symbols
    .map((sym, s) => ({ sym, s, cost: measured.get(sym)?.costBps[1] ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.cost - b.cost);
  const half = Math.floor(ranked.length / 2);
  // Two independent ways to say "liquid": the cost measured here, and the 24h
  // volume that picked the universe in the first place. They were taken at
  // different times by different means, so agreeing means something.
  const byVolume = input.symbols
    .map((sym) => ({ sym, volume: universeSymbol(sym)?.volumeUsdt ?? 0 }))
    .sort((a, b) => b.volume - a.volume);
  const groups: { label: string; keep: Set<string> }[] = [
    { label: "cheapest half", keep: new Set(ranked.slice(0, half).map((r) => r.sym)) },
    { label: "dearest half", keep: new Set(ranked.slice(half).map((r) => r.sym)) },
    { label: "top half by volume", keep: new Set(byVolume.slice(0, half).map((r) => r.sym)) },
    { label: "bottom half by volume", keep: new Set(byVolume.slice(half).map((r) => r.sym)) },
  ];
  lines.push(
    `  ${pad("group", 18)}${padLeft("names", 7)}${padLeft("xs bp", 9)}${padLeft("z", 7)}` +
      `${padLeft("gross bp", 10)}${padLeft("net bp", 9)}${padLeft("t", 7)}${padLeft("ann %", 8)}` +
      `${padLeft("mean slip", 11)}`,
  );
  const groupRows: Record<string, unknown>[] = [];
  for (const g of groups) {
    const idx = input.symbols.map((sym, s) => (g.keep.has(sym) ? s : -1)).filter((s) => s >= 0);
    const sub: FactorInput = {
      symbols: idx.map((s) => input.symbols[s]),
      times: input.times,
      feature: idx.map((s) => input.feature[s]),
      close: idx.map((s) => input.close[s]),
    };
    const subPanel = buildPanel(
      idx.map<PanelSeries>((s) => {
        const f = loaded.find((l) => l.symbol === input.symbols[s])!;
        return { symbol: f.symbol, time: f.time, feature: f.feature, forward: f.forward };
      }),
    );
    const xs = crossSectionalSpread(subPanel, { side, bandwidth: Math.max(1, 2 * horizon), minSymbols: 6 });
    const subSlip = slipAt(headlineNotional);
    const cost = costVector(sub.symbols, feeBps, subSlip, 1);
    const p: LiquidityFactorParams = {
      side,
      rebalanceBars: rebalance,
      minSymbols: 6,
      contrarian: true,
      longOnly: false,
      grossLeverage: 1,
      costBpsPerSide: cost,
    };
    const free = runLiquidityFactor(sub, { ...p, costBpsPerSide: new Float64Array(sub.symbols.length) });
    const paid = runLiquidityFactor(sub, p);
    let slipSum = 0;
    let slipCount = 0;
    for (const sym of sub.symbols) {
      const v = subSlip.get(sym);
      if (Number.isFinite(v)) {
        slipSum += v as number;
        slipCount++;
      }
    }
    lines.push(
      `  ${pad(g.label, 18)}${padLeft(String(sub.symbols.length), 7)}${padLeft(num(xs.spreadBps, 1), 9)}` +
        `${padLeft(num(xs.z, 2), 7)}${padLeft(num(free.netBps, 2), 10)}${padLeft(num(paid.netBps, 2), 9)}` +
        `${padLeft(num(paid.netT, 2), 7)}${padLeft(num(paid.annualReturnPct, 1), 8)}` +
        `${padLeft(num(slipCount > 0 ? slipSum / slipCount : Number.NaN, 3), 11)}`,
    );
    groupRows.push({
      label: g.label,
      symbols: sub.symbols,
      crossSection: xs,
      gross: { ...free, periods: undefined },
      net: { ...paid, periods: undefined },
    });
  }
  json.liquidityHalves = groupRows;

  lines.push("");
  lines.push("  per-symbol contribution to the full book, net of nothing (gross bp per period)");
  const full = runLiquidityFactor(input, baseParams(new Float64Array(n)));
  const contrib = input.symbols
    .map((sym, s) => ({
      sym,
      bps: full.contributionBySymbol[s],
      turnover: full.turnoverBySymbol[s] / Math.max(1, full.periods.length),
      slip: slip.get(sym) ?? Number.NaN,
    }))
    .sort((a, b) => b.bps - a.bps);
  lines.push(`  ${pad("symbol", 14)}${padLeft("gross bp", 10)}${padLeft("turnover", 10)}${padLeft("slip bp", 9)}`);
  for (const c of contrib) {
    lines.push(
      pad(c.sym, 14) + padLeft(num(c.bps, 2), 10) + padLeft(num(c.turnover, 3), 10) + padLeft(num(c.slip, 3), 9),
    );
  }
  json.contribution = contrib;

  lines.push("");
  lines.push("  leave one symbol out: the book rerun on the other 43, measured slippage, ranked by damage");
  const loCost = costVector(input.symbols, feeBps, slip, 1);
  const withAll = runLiquidityFactor(input, baseParams(loCost));
  const jack: { sym: string; netBps: number; t: number; annualPct: number }[] = [];
  for (let s = 0; s < n; s++) {
    const excluded = new Array(n).fill(false);
    excluded[s] = true;
    const r = runLiquidityFactor(input, baseParams(loCost, { excluded }));
    jack.push({ sym: input.symbols[s], netBps: r.netBps, t: r.netT, annualPct: r.annualReturnPct });
  }
  jack.sort((a, b) => a.netBps - b.netBps);
  lines.push(
    `  ${pad("dropped", 14)}${padLeft("net bp", 9)}${padLeft("t", 7)}${padLeft("ann %", 8)}` +
      `${padLeft("vs all", 9)}`,
  );
  for (const j of jack.slice(0, 8)) {
    lines.push(
      pad(j.sym, 14) +
        padLeft(num(j.netBps, 2), 9) +
        padLeft(num(j.t, 2), 7) +
        padLeft(num(j.annualPct, 1), 8) +
        padLeft(num(j.netBps - withAll.netBps, 2), 9),
    );
  }
  const worst = jack[0];
  lines.push(
    `  full book ${num(withAll.netBps, 2)} bp (t ${num(withAll.netT, 2)}); worst single exclusion is ` +
      `${worst.sym} at ${num(worst.netBps, 2)} bp (t ${num(worst.t, 2)}); ` +
      `${jack.filter((j) => j.t >= 1.64).length}/${n} exclusions still reach t 1.64`,
  );
  json.jackknife = { withAll: { ...withAll, periods: undefined }, folds: jack };

  /* ── 5. scaling ──────────────────────────────────────────────────────────── */

  lines.push("");
  lines.push("══ 5. where the book starts to be the problem ══");
  lines.push(
    `  ${pad("symbol", 14)}${padLeft("touch $", 10)}${padLeft("visible $", 11)}${padLeft("band1 $", 12)}` +
      `${padLeft("worst band", 12)}${padLeft("slot/worst", 12)}` +
      deposits.map((d) => padLeft(`${d}`, 11)).join(""),
  );
  const scaleRows: Record<string, unknown>[] = [];
  for (const sym of input.symbols) {
    const m = measured.get(sym);
    if (!m) continue;
    const cells = perDepositNotional.map((slot) => {
      const cost = interpolateCostBps(m.sizes, m.costBps, slot);
      const share = slot / m.band1Usdt;
      return `${num(cost, 2)}/${num(share * 100, 2)}%`;
    });
    lines.push(
      pad(sym, 14) +
        padLeft(num(m.topUsdt, 0), 10) +
        padLeft(num(m.depthVisibleUsdt, 0), 11) +
        padLeft(num(m.band1Usdt, 0), 12) +
        padLeft(num(m.worstBand1Usdt, 0), 12) +
        padLeft(`${num((headlineNotional / m.worstBand1Usdt) * 100, 2)}%`, 12) +
        cells.map((c) => padLeft(c, 11)).join(""),
    );
    scaleRows.push({ ...m });
  }
  lines.push("");
  lines.push("  cells: interpolated one-way cost in bp / the slot as a share of the +-1% band");
  lines.push(
    `  slot/worst is the ${num(headlineNotional, 0)} USDT slot against the thinnest minute seen on any sampled day`,
  );
  json.scaling = scaleRows;

  if (deep) {
    lines.push("");
    lines.push("══ five levels against twenty-five, same day ══");
    lines.push(
      `  ${pad("symbol", 14)}${padLeft("5lvl bp", 10)}${padLeft("25lvl bp", 10)}` +
        `${padLeft("5 unfilled", 12)}${padLeft("25 unfilled", 13)}`,
    );
    for (const sym of input.symbols) {
      const a = measured.get(sym);
      const b = deep.get(sym);
      if (!a || !b) continue;
      const i5 = a.sizes.indexOf(110) >= 0 ? a.sizes.indexOf(110) : 0;
      const i25 = b.sizes.indexOf(110) >= 0 ? b.sizes.indexOf(110) : 0;
      lines.push(
        pad(sym, 14) +
          padLeft(num(a.costBps[i5], 3), 10) +
          padLeft(num(b.costBps[i25], 3), 10) +
          padLeft(`${num(a.unfilledFrac[i5] * 100, 2)}%`, 12) +
          padLeft(`${num(b.unfilledFrac[i25] * 100, 2)}%`, 13),
      );
    }
  }

  const text = lines.join("\n");
  process.stdout.write(`${text}\n`);
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, tag);
    fs.writeFileSync(`${base}.txt`, `${text}\n`, "utf8");
    fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 1), "utf8");
    process.stderr.write(`\nwritten: ${base}.txt / .json\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
