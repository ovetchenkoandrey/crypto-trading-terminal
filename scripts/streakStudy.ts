/**
 * Is a losing streak informative, and what does raising size after one do?
 *
 * Runs the implemented bots over the dataset, takes their trade logs, and puts
 * the sequence of outcomes through every test that can distinguish "outcomes
 * cluster" from "outcomes are independent and long runs happen anyway".
 *
 *   npm run streak-study
 *   npm run streak-study -- --quick
 *   npm run streak-study -- --from 2024-09 --to 2026-08 --costs fees
 */

import fs from "node:fs";
import path from "node:path";
import { parseRunPlan, type RunDecl } from "../src/lib/backtest/runConfig.ts";
import { runFromSpec } from "../src/lib/backtest/cliRun.ts";
import { autocorrProfile } from "../src/lib/research/autocorr.ts";
import { adjustPValues, expectedMaxAbsZ, familywiseZThreshold } from "../src/lib/research/multipleTesting.ts";
import { mulberry32 } from "../src/lib/research/random.ts";
import {
  conditionalMeans,
  conditionalWinRates,
  maxLossRunNull,
  outcomeSigns,
  permutedConditionalWinRates,
  probRunAtLeast,
  runsTest,
  streakLengths,
  type StreakCondition,
} from "../src/lib/research/streakDependence.ts";
import {
  cumulativeStakeMultiple,
  lossRunToRuin,
  simulateMartingale,
  toRMultiples,
  type MartingaleConfig,
} from "../src/lib/research/martingale.ts";

const STRATEGIES = ["night-mr", "zz-breakout", "fractal-wave", "vwap-mr", "night-range", "trend-follow"];
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
const MAX_STREAK = 10;
const LAGS = [1, 2, 3, 4, 5];

interface Args {
  from: string;
  to: string;
  costs: "none" | "fees" | "full";
  quick: boolean;
  dataDir: string;
  out: string;
  strategies: string[];
  symbols: string[];
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
    } else bare.add(name);
  }
  return {
    from: flags.get("from") ?? "2024-09",
    to: flags.get("to") ?? "2026-08",
    costs: (flags.get("costs") as Args["costs"]) ?? "fees",
    quick: bare.has("quick"),
    dataDir: flags.get("data-dir") ?? "./data",
    out: flags.get("out") ?? "./data/reports/streak-study",
    strategies: (flags.get("bots") ?? STRATEGIES.join(",")).split(","),
    symbols: (flags.get("symbols") ?? SYMBOLS.join(",")).split(","),
  };
}

function costsDecl(preset: Args["costs"]): RunDecl["costs"] {
  if (preset === "none") return { fees: false, slippage: false };
  if (preset === "fees") return { fees: "bybit-linear", slippage: false };
  return {
    fees: "bybit-linear",
    slippage: { kind: "fixed_bps", bps: 5 },
    slippageContext: true,
    rejection: true,
    rules: true,
    funding: true,
    margin: true,
  };
}

interface Sample {
  key: string;
  bot: string;
  symbol: string;
  /** Return on notional per trade, in order of close time. */
  rets: Float64Array;
  /** Raw P&L, same order. */
  pnl: Float64Array;
  winRate: number;
  meanRetBps: number;
  spanDays: number;
}

async function collect(args: Args): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const bot of args.strategies) {
    for (const symbol of args.symbols) {
      const decl: RunDecl = {
        name: `${bot}-${symbol}`,
        market: "linear",
        symbol,
        interval: "1m",
        from: args.from,
        to: args.to,
        bot: { kind: bot, params: {} },
        costs: costsDecl(args.costs),
        initialBalance: 10000,
      };
      let trades;
      let rangeDays = 0;
      try {
        const plan = parseRunPlan(decl, "streak-study");
        const spec = plan.runs[0];
        rangeDays = (spec.toSec - spec.fromSec) / 86400;
        const outcome = await runFromSpec(spec, { dataRoot: args.dataDir });
        trades = [...outcome.result.trades].sort((a, b) => a.ts - b.ts);
      } catch (err) {
        process.stderr.write(`skip ${bot}/${symbol}: ${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
      if (trades.length < 100) {
        process.stderr.write(`skip ${bot}/${symbol}: only ${trades.length} trades\n`);
        continue;
      }
      const rets = new Float64Array(trades.length);
      const pnl = new Float64Array(trades.length);
      let wins = 0;
      for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        const notional = Math.abs(t.entryPrice * t.qty);
        rets[i] = notional > 0 ? t.pnl / notional : 0;
        pnl[i] = t.pnl;
        if (t.pnl > 0) wins++;
      }
      // Calendar span of the requested range, not of the first-to-last trade: a
      // strategy that went quiet for a year still had that year to trade in.
      const spanDays = rangeDays;
      let sum = 0;
      for (let i = 0; i < rets.length; i++) sum += rets[i];
      out.push({
        key: `${bot}/${symbol}`,
        bot,
        symbol,
        rets,
        pnl,
        winRate: wins / trades.length,
        meanRetBps: (sum / rets.length) * 1e4,
        spanDays,
      });
      process.stderr.write(`ok   ${bot}/${symbol}: ${trades.length} trades\n`);
    }
  }
  return out;
}

const f = (x: number, d = 3): string => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pad = (s: string, n: number): string => s.padEnd(n);
const rp = (s: string, n: number): string => s.padStart(n);

function section(lines: string[], title: string): void {
  lines.push("");
  lines.push("=".repeat(94));
  lines.push(title);
  lines.push("=".repeat(94));
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const perms = args.quick ? 300 : 2000;
  const sims = args.quick ? 3000 : 20000;
  const paths = args.quick ? 2000 : 10000;

  process.stderr.write(`streak study: ${args.from} .. ${args.to}, costs=${args.costs}\n`);
  const samples = await collect(args);
  if (samples.length === 0) throw new Error("no strategy produced enough trades");

  const L: string[] = [];
  L.push(`Streak dependence and stake escalation`);
  L.push(`range ${args.from} .. ${args.to}   costs ${args.costs}   permutations ${perms}   simulations ${sims}`);

  /* 0. inventory */
  section(L, "0. Samples");
  L.push(`${pad("strategy/symbol", 26)}${rp("trades", 8)}${rp("win%", 8)}${rp("mean bps", 10)}${rp("days", 7)}${rp("tr/yr", 8)}${rp("maxLoss", 9)}${rp("maxWin", 8)}`);
  for (const s of samples) {
    const st = streakLengths(s.rets);
    const perYear = (s.rets.length / Math.max(1, s.spanDays)) * 365;
    L.push(
      pad(s.key, 26) + rp(String(s.rets.length), 8) + rp(f(100 * s.winRate, 1), 8) +
      rp(f(s.meanRetBps, 2), 10) + rp(f(s.spanDays, 0), 7) + rp(f(perYear, 0), 8) +
      rp(String(st.maxLoss), 9) + rp(String(st.maxWin), 8),
    );
  }

  /* 1. autocorrelation of outcome signs */
  section(L, "1. Autocorrelation of the outcome sign (robust standard errors)");
  const acTests: { label: string; p: number }[] = [];
  const acRows: string[] = [];
  acRows.push(`${pad("strategy/symbol", 26)}${rp("lag", 5)}${rp("rho", 9)}${rp("seRobust", 10)}${rp("z", 8)}${rp("p", 10)}`);
  for (const s of samples) {
    const signs = outcomeSigns(s.rets);
    for (const r of autocorrProfile([signs], LAGS)) {
      acRows.push(
        pad(s.key, 26) + rp(String(r.lag), 5) + rp(f(r.rho, 4), 9) + rp(f(r.seRobust, 4), 10) +
        rp(f(r.z, 2), 8) + rp(r.p < 1e-4 ? r.p.toExponential(1) : f(r.p, 4), 10),
      );
      acTests.push({ label: `${s.key} lag${r.lag}`, p: r.p });
    }
  }
  L.push(...acRows);
  const acAdj = adjustPValues(acTests);
  const acSurvivors = acAdj.filter((t) => t.bonferroni < 0.05);
  const acBh = acAdj.filter((t) => t.bh < 0.05);
  L.push("");
  L.push(`family of ${acTests.length} tests; a single test must clear |z| = ${f(familywiseZThreshold(acTests.length), 2)} for Bonferroni 5%, and pure noise already delivers |z| = ${f(expectedMaxAbsZ(acTests.length), 2)} as its expected maximum`);
  L.push(`survive Bonferroni 5%: ${acSurvivors.length} — ${acSurvivors.map((t) => `${t.label} (p=${t.p.toExponential(1)})`).join(", ") || "none"}`);
  L.push(`survive Benjamini-Hochberg 5%: ${acBh.length} — ${acBh.map((t) => t.label).join(", ") || "none"}`);

  /* 2. conditional win rate */
  section(L, "2. P(win | previous N trades all lost) vs the same trades not preceded by such a run");
  const condTests: { label: string; p: number }[] = [];
  for (const s of samples) {
    const rows = conditionalWinRates(s.rets, MAX_STREAK);
    L.push("");
    L.push(`${s.key}   unconditional win rate ${f(100 * s.winRate, 1)}%`);
    L.push(`${rp("N", 3)}${rp("n", 8)}${rp("P(win|N)", 11)}${rp("95% CI", 20)}${rp("P(win|<N)", 11)}${rp("diff", 9)}${rp("z", 8)}${rp("p", 9)}`);
    for (const r of rows) {
      const ci = r.n > 0 ? `[${f(100 * r.ciLo, 1)}, ${f(100 * r.ciHi, 1)}]` : "-";
      L.push(
        rp(String(r.streak), 3) + rp(String(r.n), 8) + rp(r.n ? f(100 * r.winRate, 1) : "-", 11) +
        rp(ci, 20) + rp(f(100 * r.compWinRate, 1), 11) + rp(r.n ? f(100 * r.diff, 1) : "-", 9) +
        rp(f(r.z, 2), 8) + rp(Number.isFinite(r.p) ? f(r.p, 4) : "-", 9),
      );
      if (r.n >= 20) condTests.push({ label: `${s.key} N=${r.streak}`, p: r.p });
    }
  }
  const condAdj = adjustPValues(condTests);
  const condSurv = condAdj.filter((t) => t.bonferroni < 0.05);
  L.push("");
  L.push(`family of ${condTests.length} conditional tests with n >= 20`);
  L.push(`survive Bonferroni 5%: ${condSurv.length} — ${condSurv.map((t) => `${t.label} (p=${t.p.toExponential(1)})`).join(", ") || "none"}`);
  L.push(`survive Benjamini-Hochberg 5%: ${condAdj.filter((t) => t.bh < 0.05).length}`);

  /* 3. permutation null for the conditional win rate */
  section(L, "3. Permutation null: the same trades in random order");
  L.push(`${pad("strategy/symbol", 26)}${rp("N", 4)}${rp("n", 8)}${rp("observed", 11)}${rp("null mean", 11)}${rp("null 95% band", 22)}${rp("p", 8)}`);
  for (const s of samples) {
    const rows = permutedConditionalWinRates(s.rets, 5, perms, mulberry32(20260826 + s.key.length));
    for (const r of rows) {
      if (r.n < 20) continue;
      L.push(
        pad(s.key, 26) + rp(String(r.streak), 4) + rp(String(r.n), 8) + rp(f(100 * r.observed, 1), 11) +
        rp(f(100 * r.nullMean, 1), 11) + rp(`[${f(100 * r.nullLo, 1)}, ${f(100 * r.nullHi, 1)}]`, 22) + rp(f(r.p, 3), 8),
      );
    }
  }

  /* 4. runs test */
  section(L, "4. Wald-Wolfowitz runs test (fewer runs than expected = outcomes cluster)");
  L.push(`${pad("strategy/symbol", 26)}${rp("n", 8)}${rp("runs", 8)}${rp("expected", 11)}${rp("z", 8)}${rp("p", 10)}${rp("verdict", 14)}`);
  const runTests: { label: string; p: number }[] = [];
  for (const s of samples) {
    const r = runsTest(s.rets);
    runTests.push({ label: s.key, p: r.p });
    const verdict = !Number.isFinite(r.z) ? "-" : r.p > 0.05 ? "random" : r.z < 0 ? "clustered" : "alternating";
    L.push(
      pad(s.key, 26) + rp(String(r.n), 8) + rp(String(r.runs), 8) + rp(f(r.expected, 1), 11) +
      rp(f(r.z, 2), 8) + rp(r.p < 1e-4 ? r.p.toExponential(1) : f(r.p, 4), 10) + rp(verdict, 14),
    );
  }
  const runAdj = adjustPValues(runTests);
  L.push("");
  L.push(`survive Bonferroni 5%: ${runAdj.filter((t) => t.bonferroni < 0.05).map((t) => t.label).join(", ") || "none"}`);

  /* 5. longest losing run against the independent null */
  section(L, "5. Longest losing run against a coin with the same win rate");
  L.push(`${pad("strategy/symbol", 26)}${rp("n", 8)}${rp("loss%", 8)}${rp("observed", 10)}${rp("null mean", 11)}${rp("null p95", 10)}${rp("null max", 10)}${rp("P(>=obs)", 10)}`);
  const runLenTests: { label: string; p: number }[] = [];
  for (const s of samples) {
    const nul = maxLossRunNull(s.rets, sims, mulberry32(4242 + s.key.length));
    runLenTests.push({ label: s.key, p: nul.pAtLeast });
    L.push(
      pad(s.key, 26) + rp(String(nul.n), 8) + rp(f(100 * nul.lossRate, 1), 8) + rp(String(nul.observed), 10) +
      rp(f(nul.nullMean, 1), 11) + rp(f(nul.nullP95, 0), 10) + rp(String(nul.nullMax), 10) + rp(f(nul.pAtLeast, 3), 10),
    );
  }
  const runLenAdj = adjustPValues(runLenTests);
  L.push("");
  L.push(`family of ${runLenTests.length} tests; survive Bonferroni 5%: ${runLenAdj.filter((t) => t.bonferroni < 0.05).map((t) => t.label).join(", ") || "none"}`);
  L.push(`survive Benjamini-Hochberg 5%: ${runLenAdj.filter((t) => t.bh < 0.05).map((t) => t.label).join(", ") || "none"}`);

  /* 6. conditional mean return */
  section(L, "6. Mean return on notional after a losing run (basis points)");
  L.push(`${pad("strategy/symbol", 26)}${rp("N", 4)}${rp("n", 8)}${rp("mean bps", 11)}${rp("se", 9)}${rp("other bps", 11)}${rp("diff", 9)}${rp("t", 8)}${rp("p", 9)}`);
  const meanTests: { label: string; p: number }[] = [];
  for (const s of samples) {
    for (const r of conditionalMeans(s.rets, MAX_STREAK)) {
      if (r.n < 20) continue;
      meanTests.push({ label: `${s.key} N=${r.streak}`, p: r.p });
      if (r.streak > 5 && r.streak % 5 !== 0) continue;
      L.push(
        pad(s.key, 26) + rp(String(r.streak), 4) + rp(String(r.n), 8) + rp(f(1e4 * r.meanRet, 2), 11) +
        rp(f(1e4 * r.se, 2), 9) + rp(f(1e4 * r.compMean, 2), 11) + rp(f(1e4 * r.diff, 2), 9) +
        rp(f(r.t, 2), 8) + rp(f(r.p, 4), 9),
      );
    }
  }
  const meanAdj = adjustPValues(meanTests);
  L.push("");
  L.push(`family of ${meanTests.length} tests; survive Bonferroni 5%: ${meanAdj.filter((t) => t.bonferroni < 0.05).map((t) => `${t.label} (p=${t.p.toExponential(1)})`).join(", ") || "none"}`);
  L.push(`survive Benjamini-Hochberg 5%: ${meanAdj.filter((t) => t.bh < 0.05).length}`);

  /* 7. stability across halves */
  section(L, "7. Does anything repeat? Same statistic on the first and second half of each track");
  L.push(`${pad("strategy/symbol", 26)}${rp("N", 4)}${rp("diff H1", 10)}${rp("n H1", 8)}${rp("diff H2", 10)}${rp("n H2", 8)}${rp("same sign", 11)}`);
  let agree = 0;
  let total = 0;
  for (const s of samples) {
    const mid = Math.floor(s.rets.length / 2);
    const h1 = s.rets.slice(0, mid);
    const h2 = s.rets.slice(mid);
    const a = conditionalWinRates(h1, 5);
    const b = conditionalWinRates(h2, 5);
    for (let i = 0; i < 5; i++) {
      const ra: StreakCondition = a[i];
      const rb: StreakCondition = b[i];
      if (ra.n < 20 || rb.n < 20) continue;
      const same = Math.sign(ra.diff) === Math.sign(rb.diff);
      total++;
      if (same) agree++;
      L.push(
        pad(s.key, 26) + rp(String(ra.streak), 4) + rp(f(100 * ra.diff, 1), 10) + rp(String(ra.n), 8) +
        rp(f(100 * rb.diff, 1), 10) + rp(String(rb.n), 8) + rp(same ? "yes" : "no", 11),
      );
    }
  }
  L.push("");
  const agreeZ = total > 0 ? (agree - total / 2) / Math.sqrt(total * 0.25) : Number.NaN;
  L.push(`sign of the effect repeats in ${agree}/${total} cells (${f((100 * agree) / Math.max(1, total), 1)}%); a coin gives 50%, z = ${f(agreeZ, 2)}`);
  L.push("Cells are nested (N = 1..5 on the same track), so this z overstates the evidence.");

  /* 8. ruin arithmetic */
  section(L, "8. Stake escalation: how many consecutive losses kill the account");
  L.push("Risk is a fraction of current equity per 1 R; a losing trade costs about 1 R.");
  L.push("Ruin floor: equity down to 20% of the starting balance.");
  L.push("");
  L.push(`${rp("base risk", 11)}${rp("mult", 7)}${rp("cum stake at ruin", 20)}${rp("losses to ruin", 16)}${rp("risk on that trade", 20)}`);
  const grid: { baseRisk: number; multiplier: number }[] = [];
  for (const baseRisk of [0.01, 0.02, 0.05]) {
    for (const multiplier of [1, 1.5, 2, 3]) grid.push({ baseRisk, multiplier });
  }
  for (const g of grid) {
    const cfg: MartingaleConfig = { ...g, maxSteps: 0, ruinFloor: 0.2, compounding: true };
    const k = lossRunToRuin(cfg);
    const kk = Number.isFinite(k) ? k : 0;
    L.push(
      rp(f(100 * g.baseRisk, 1) + "%", 11) + rp(f(g.multiplier, 1), 7) +
      rp(Number.isFinite(k) ? f(cumulativeStakeMultiple(g.multiplier, kk), 1) + "x base" : "-", 20) +
      rp(Number.isFinite(k) ? String(k) : "never (flat)", 16) +
      rp(Number.isFinite(k) ? f(100 * g.baseRisk * Math.pow(g.multiplier, kk - 1), 1) + "%" : "-", 20),
    );
  }

  section(L, "9. Probability of hitting that losing run, per strategy, per year");
  L.push(`${pad("strategy/symbol", 26)}${rp("loss%", 8)}${rp("tr/yr", 8)}${rp("P(run>=5)/yr", 14)}${rp("P(>=7)/yr", 12)}${rp("P(>=10)/yr", 13)}${rp("P(>=13)/yr", 13)}`);
  for (const s of samples) {
    const lossRate = 1 - s.winRate;
    const perYear = Math.round((s.rets.length / Math.max(1, s.spanDays)) * 365);
    const row = [5, 7, 10, 13].map((k) => f(probRunAtLeast(perYear, k, lossRate), 4));
    L.push(
      pad(s.key, 26) + rp(f(100 * lossRate, 1), 8) + rp(String(perYear), 8) +
      rp(row[0], 14) + rp(row[1], 12) + rp(row[2], 13) + rp(row[3], 13),
    );
  }

  /* 10. what the scheme does to the distribution of the result */
  section(L, "10. Flat sizing vs doubling after a loss, on each strategy's own trades");
  L.push("Trades are resampled in random order from the strategy's own P&L distribution,");
  L.push("expressed in R multiples (mean loss = 1 R). One path = one year of that strategy.");
  L.push("");
  L.push(`${pad("strategy/symbol", 22)}${rp("scheme", 12)}${rp("ruin%", 8)}${rp("median", 9)}${rp("mean", 9)}${rp("p05", 8)}${rp("p95", 9)}${rp("medDD%", 9)}${rp("trades to ruin", 16)}`);
  const schemes: { name: string; cfg: Omit<MartingaleConfig, "ruinFloor" | "compounding"> }[] = [
    { name: "flat 1%", cfg: { baseRisk: 0.01, multiplier: 1, maxSteps: 0 } },
    { name: "x1.5", cfg: { baseRisk: 0.01, multiplier: 1.5, maxSteps: 0 } },
    { name: "x2", cfg: { baseRisk: 0.01, multiplier: 2, maxSteps: 0 } },
    { name: "x2 cap 4", cfg: { baseRisk: 0.01, multiplier: 2, maxSteps: 4 } },
    { name: "x3", cfg: { baseRisk: 0.01, multiplier: 3, maxSteps: 0 } },
  ];
  for (const s of samples) {
    const { r } = toRMultiples(s.pnl);
    const perYear = Math.max(50, Math.round((s.rets.length / Math.max(1, s.spanDays)) * 365));
    for (const scheme of schemes) {
      const cfg: MartingaleConfig = { ...scheme.cfg, ruinFloor: 0.2, compounding: true };
      const o = simulateMartingale(r, cfg, perYear, paths, mulberry32(777 + s.key.length + scheme.name.length));
      L.push(
        pad(s.key, 22) + rp(scheme.name, 12) + rp(f(100 * o.ruinRate, 1), 8) + rp(f(o.medianFinal, 3), 9) +
        rp(f(o.meanFinal, 3), 9) + rp(f(o.p05, 3), 8) + rp(f(o.p95, 3), 9) +
        rp(f(100 * o.medianMaxDrawdown, 1), 9) + rp(Number.isFinite(o.medianTradesToRuin) ? f(o.medianTradesToRuin, 0) : "-", 16),
      );
    }
  }

  section(L, "11. The theorem, checked numerically: no sizing rule fixes a negative edge");
  L.push("Expected P&L of one bet is (stake x mean R), and the stake is fixed before the outcome is");
  L.push("known. Summed over any rule whatsoever, expected terminal equity stays below the starting");
  L.push("balance. Column 'exact' switches off limited liability so that identity holds without");
  L.push("truncation; 'as traded' is the realistic account that cannot go below zero, where a handful");
  L.push("of lottery paths can lift the arithmetic mean while the median sits at zero.");
  L.push("");
  L.push(`${pad("strategy/symbol", 22)}${rp("mean R", 9)}${rp("scheme", 10)}${rp("mean exact", 12)}${rp("mean as traded", 16)}${rp("median", 9)}${rp("ruin%", 8)}`);
  for (const s of samples) {
    const { r } = toRMultiples(s.pnl);
    let meanR = 0;
    for (let i = 0; i < r.length; i++) meanR += r[i];
    meanR /= r.length;
    const perYear = Math.max(50, Math.round((s.rets.length / Math.max(1, s.spanDays)) * 365));
    for (const [name, mult] of [["flat", 1], ["x1.5", 1.5], ["x2", 2], ["x3", 3]] as const) {
      const base: MartingaleConfig = { baseRisk: 0.01, multiplier: mult, maxSteps: 0, ruinFloor: 0.2, compounding: true };
      const exact = simulateMartingale(r, { ...base, limitedLiability: false }, perYear, paths, mulberry32(31337 + s.key.length));
      const traded = simulateMartingale(r, base, perYear, paths, mulberry32(31337 + s.key.length));
      L.push(
        pad(name === "flat" ? s.key : "", 22) + rp(name === "flat" ? f(meanR, 4) : "", 9) + rp(name, 10) +
        rp(f(exact.meanFinal, 3), 12) + rp(f(traded.meanFinal, 3), 16) +
        rp(f(traded.medianFinal, 3), 9) + rp(f(100 * traded.ruinRate, 1), 8),
      );
    }
  }

  section(L, "12. Control: the same schemes on a strategy that actually makes money");
  L.push("Every bot above has a negative edge, so everything dies and the schemes differ only in speed.");
  L.push("These rows are synthetic: 45% winners paying 1.5 R, 55% losers costing 1 R, mean +0.125 R,");
  L.push("1000 trades per path. Nothing here is about the market, only about the sizing rule.");
  L.push("");
  const good = new Float64Array(2000);
  for (let i = 0; i < good.length; i++) good[i] = i < 900 ? 1.5 : -1;
  L.push(`${rp("scheme", 12)}${rp("base risk", 11)}${rp("ruin%", 8)}${rp("median", 9)}${rp("mean", 9)}${rp("p05", 8)}${rp("p95", 9)}${rp("medDD%", 9)}`);
  for (const [name, mult, risk] of [
    ["flat", 1, 0.01], ["flat", 1, 0.02], ["x1.5", 1.5, 0.01], ["x2", 2, 0.01],
    ["x2 cap 4", 2, 0.01], ["x3", 3, 0.01],
  ] as const) {
    const cfg: MartingaleConfig = {
      baseRisk: risk,
      multiplier: mult,
      maxSteps: name === "x2 cap 4" ? 4 : 0,
      ruinFloor: 0.2,
      compounding: true,
    };
    const o = simulateMartingale(good, cfg, 1000, paths, mulberry32(9001));
    L.push(
      rp(name, 12) + rp(f(100 * risk, 1) + "%", 11) + rp(f(100 * o.ruinRate, 1), 8) + rp(f(o.medianFinal, 3), 9) +
      rp(f(o.meanFinal, 3), 9) + rp(f(o.p05, 3), 8) + rp(f(o.p95, 3), 9) + rp(f(100 * o.medianMaxDrawdown, 1), 9),
    );
  }

  const text = L.join("\n");
  process.stdout.write(text + "\n");

  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "streak-study.txt"), text, "utf8");
  process.stderr.write(`\nwritten: ${path.join(outDir, "streak-study.txt")}\n`);
}

void run();
