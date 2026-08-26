import fs from "node:fs";
import path from "node:path";
import { createCandleStore } from "../src/lib/data/candleStore.ts";
import { createFundingStore, type FundingEvent } from "../src/lib/data/fundingStore.ts";
import { monthOf, monthRange, toISO } from "../src/lib/data/months.ts";
import { reportsDir, resolveDataRoot, type Market } from "../src/lib/data/paths.ts";
import { mean, quantile, stdev } from "../src/lib/research/descriptive.ts";
import { twoSidedP } from "../src/lib/research/distributions.ts";
import { neweyWestSE } from "../src/lib/research/autocorr.ts";

/**
 * Measures the funding rate itself over the full history: how the distribution
 * looks per epoch, how often extremes happen, whether they cluster, and what
 * price does afterwards.
 *
 * Nothing here trades. It exists to answer, before any bot is written, whether
 * the extreme-funding hypothesis has anything behind it beyond a handful of
 * historical episodes.
 */

const USAGE = `
Usage:
  node scripts/fundingStudy.ts --symbols BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT

  --symbols <list>   comma separated (default: BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT)
  --to <YYYY-MM-DD>  last settlement to include (default: 2024-12-31, the in-sample edge)
  --from <YYYY-MM-DD> first settlement to include (default: dataset start)
  --horizons <list>  forward horizons in hours (default: 8,16,24,48,72,168)
  --data-dir <path>  dataset root
  --out <path>       write the text report here as well as stdout
`.trim();

const HOUR = 3600;
const BPS = 1e4;

interface Args {
  symbols: string[];
  fromSec: number;
  toSec: number;
  horizonsH: number[];
  dataRoot: string;
  out: string | null;
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    process.stderr.write(`--${name} needs a value\n${USAGE}\n`);
    process.exit(2);
  }
  return v;
}

function parseDay(raw: string, end: boolean): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (m) {
    const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
    return end ? base + 86_400 - 1 : base;
  }
  const mm = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (mm) {
    const y = Number(mm[1]);
    const mo = Number(mm[2]);
    return end ? Date.UTC(y, mo, 1) / 1000 - 1 : Date.UTC(y, mo - 1, 1) / 1000;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    process.stderr.write(`cannot read date "${raw}"\n`);
    process.exit(2);
  }
  return Math.floor(ms / 1000);
}

function parseArgs(argv: readonly string[]): Args {
  return {
    symbols: (arg(argv, "symbols") ?? "BTCUSDT,ETHUSDT,XRPUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean),
    fromSec: arg(argv, "from") ? parseDay(arg(argv, "from")!, false) : 0,
    toSec: parseDay(arg(argv, "to") ?? "2024-12-31", true),
    horizonsH: (arg(argv, "horizons") ?? "8,16,24,48,72,168").split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
    dataRoot: resolveDataRoot(arg(argv, "data-dir")),
    out: arg(argv, "out") ?? null,
  };
}

/* ── price access ─────────────────────────────────────────────────────────── */

interface PriceSeries {
  times: Int32Array;
  closes: Float64Array;
}

/**
 * Minute closes for a symbol, flattened into typed arrays. The candle objects
 * are dropped month by month so the whole six-year history fits without
 * holding several million objects alive at once.
 */
function loadPrices(root: string, market: Market, symbol: string): PriceSeries {
  const store = createCandleStore(root);
  const months = store.listMonths({ market, symbol, interval: "1m" });
  const timeChunks: number[][] = [];
  const closeChunks: number[][] = [];
  let total = 0;
  for (const m of months) {
    const bars = store.readMonth({ market, symbol, interval: "1m" }, m);
    const t: number[] = new Array(bars.length);
    const c: number[] = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      t[i] = bars[i].time;
      c[i] = bars[i].close;
    }
    timeChunks.push(t);
    closeChunks.push(c);
    total += bars.length;
  }
  const times = new Int32Array(total);
  const closes = new Float64Array(total);
  let off = 0;
  for (let k = 0; k < timeChunks.length; k++) {
    times.set(timeChunks[k], off);
    closes.set(closeChunks[k], off);
    off += timeChunks[k].length;
    timeChunks[k] = [];
    closeChunks[k] = [];
  }
  return { times, closes };
}

/** Close of the first bar at or after `timeSec`, within `toleranceSec`. */
function priceAt(series: PriceSeries, timeSec: number, toleranceSec = 15 * 60): number | null {
  const t = series.times;
  let lo = 0;
  let hi = t.length - 1;
  if (hi < 0 || timeSec > t[hi]) return null;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < timeSec) lo = mid + 1;
    else hi = mid;
  }
  if (t[lo] < timeSec) return null;
  if (t[lo] - timeSec > toleranceSec) return null;
  const v = series.closes[lo];
  return v > 0 ? v : null;
}

/* ── statistics helpers ───────────────────────────────────────────────────── */

interface Summary {
  n: number;
  meanBps: number;
  seBps: number;
  nwSeBps: number;
  t: number;
  nwT: number;
  p: number;
  lo95: number;
  hi95: number;
  medianBps: number;
}

const Z95 = 1.959963985;

/**
 * Mean with two standard errors: the naive one and a Newey-West version whose
 * bandwidth covers the overlap between consecutive observations. Forward
 * windows longer than the settlement interval overlap by construction, and the
 * naive t on overlapping samples is inflated.
 */
function summarize(values: readonly number[], overlap: number): Summary {
  const arr = Float64Array.from(values);
  const m = mean(arr);
  const se = arr.length > 1 ? stdev(arr, m) / Math.sqrt(arr.length) : Number.NaN;
  const band = Math.max(0, Math.min(overlap, arr.length - 1));
  const nwSe = arr.length > 1 ? neweyWestSE(arr, band) : Number.NaN;
  return {
    n: arr.length,
    meanBps: m * BPS,
    seBps: se * BPS,
    nwSeBps: nwSe * BPS,
    t: m / se,
    nwT: m / nwSe,
    p: twoSidedP(m / nwSe),
    lo95: (m - Z95 * nwSe) * BPS,
    hi95: (m + Z95 * nwSe) * BPS,
    medianBps: arr.length > 0 ? quantile(arr, 0.5) * BPS : Number.NaN,
  };
}

function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return "  n/a";
  return x.toFixed(digits);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function padR(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/* ── the study ────────────────────────────────────────────────────────────── */

interface Observation {
  time: number;
  rate: number;
  /** Seconds until the next settlement — the actual interval, not an assumed 8h. */
  intervalSec: number;
  /** Forward log returns keyed by horizon hours. */
  fwd: Map<number, number>;
}

function yearOf(sec: number): number {
  return new Date(sec * 1000).getUTCFullYear();
}

/**
 * Equal-count buckets by rank, not by quantile value. The rate is capped at
 * 1 bp for long stretches, so a quantile cut lands on a tie and collapses two
 * buckets into one; ranking splits the ties instead of losing them.
 */
function rankBuckets(obs: readonly Observation[], count: number): Observation[][] {
  const sorted = [...obs].sort((a, b) => a.rate - b.rate);
  const out: Observation[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < sorted.length; i++) {
    const idx = Math.min(count - 1, Math.floor((i * count) / sorted.length));
    out[idx].push(sorted[i]);
  }
  return out;
}

/**
 * Extremes arrive in bursts: one squeeze produces a dozen consecutive
 * settlements. Treating them as independent observations is the main way to
 * manufacture significance here, so they are collapsed into episodes — a new
 * one starts after `gapSec` of quiet — and the test runs across episodes.
 */
function episodes(rows: readonly Observation[], gapSec: number): Observation[][] {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const out: Observation[][] = [];
  let cur: Observation[] = [];
  for (const o of sorted) {
    if (cur.length > 0 && o.time - cur[cur.length - 1].time > gapSec) {
      out.push(cur);
      cur = [];
    }
    cur.push(o);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const args = parseArgs(argv);
  const out: string[] = [];
  const say = (line = "") => {
    out.push(line);
    process.stdout.write(`${line}\n`);
  };

  const funding = createFundingStore(args.dataRoot);
  say(`FUNDING STUDY — settlements up to ${toISO(args.toSec)}`);
  say(`data: ${args.dataRoot}`);
  say();

  const perSymbol = new Map<string, Observation[]>();
  const intervalNotes: string[] = [];

  for (const symbol of args.symbols) {
    process.stderr.write(`  loading ${symbol}\n`);
    const all = funding.readRange("linear", symbol, 0, 2_000_000_000);
    if (all.length === 0) {
      say(`${symbol}: no funding history`);
      continue;
    }
    const prices = loadPrices(args.dataRoot, "linear", symbol);

    // Interval comes from the timestamps themselves. The FTX week broke the
    // eight-hour grid on SOL, and a hardcoded step would misprice every window
    // around it.
    const diffs = new Map<number, number>();
    for (let i = 1; i < all.length; i++) {
      const d = all[i].time - all[i - 1].time;
      diffs.set(d, (diffs.get(d) ?? 0) + 1);
    }
    const diffRows = Array.from(diffs.entries()).sort((a, b) => b[1] - a[1]);
    intervalNotes.push(
      `${symbol}: ${diffRows.slice(0, 4).map(([d, c]) => `${(d / HOUR).toFixed(2)}h x${c}`).join(", ")}` +
      (diffRows.length > 4 ? `, +${diffRows.length - 4} other steps` : ""),
    );

    const obs: Observation[] = [];
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (e.time < args.fromSec || e.time > args.toSec) continue;
      const nextSec = i + 1 < all.length ? all[i + 1].time - e.time : 8 * HOUR;
      const p0 = priceAt(prices, e.time);
      if (p0 === null) continue;
      const fwd = new Map<number, number>();
      for (const h of args.horizonsH) {
        const p1 = priceAt(prices, e.time + h * HOUR);
        if (p1 !== null) fwd.set(h, Math.log(p1 / p0));
      }
      obs.push({ time: e.time, rate: e.rate, intervalSec: nextSec, fwd });
    }
    perSymbol.set(symbol, obs);
  }

  say("=== 1. Settlement interval (read from timestamps) ===");
  for (const n of intervalNotes) say(`  ${n}`);
  say();

  /* --- distribution per symbol and per year --- */

  say("=== 2. Rate distribution over the full history ===");
  say(`  ${padR("symbol", 9)}${pad("n", 6)}${pad("mean", 8)}${pad("sd", 8)}${pad("p1", 8)}${pad("p5", 8)}${pad("p50", 8)}${pad("p95", 8)}${pad("p99", 8)}${pad("p99.5", 8)}${pad("min", 10)}${pad("max", 9)}   (bps per settlement)`);
  for (const [symbol, obs] of perSymbol) {
    const r = Float64Array.from(obs.map((o) => o.rate * BPS));
    if (r.length === 0) continue;
    const m = mean(r);
    say(
      `  ${padR(symbol, 9)}${pad(String(r.length), 6)}${pad(fmt(m), 8)}${pad(fmt(stdev(r, m)), 8)}` +
      `${pad(fmt(quantile(r, 0.01)), 8)}${pad(fmt(quantile(r, 0.05)), 8)}${pad(fmt(quantile(r, 0.5)), 8)}` +
      `${pad(fmt(quantile(r, 0.95)), 8)}${pad(fmt(quantile(r, 0.99)), 8)}${pad(fmt(quantile(r, 0.995)), 8)}` +
      `${pad(fmt(Math.min(...r)), 10)}${pad(fmt(Math.max(...r)), 9)}`,
    );
  }
  say();

  const EXTREME_BPS = [10, 20, 30, 50, 100];
  say("=== 3. Extremes by year — count of |rate| above threshold (bps) ===");
  say(`  ${padR("symbol", 9)}${pad("year", 6)}${pad("n", 6)}${pad("mean", 8)}${EXTREME_BPS.map((b) => pad(`>|${b}|`, 8)).join("")}${pad("min", 10)}${pad("max", 9)}`);
  for (const [symbol, obs] of perSymbol) {
    const years = Array.from(new Set(obs.map((o) => yearOf(o.time)))).sort();
    for (const y of years) {
      const rows = obs.filter((o) => yearOf(o.time) === y);
      const r = Float64Array.from(rows.map((o) => o.rate * BPS));
      const counts = EXTREME_BPS.map((b) => rows.filter((o) => Math.abs(o.rate * BPS) > b).length);
      say(
        `  ${padR(symbol, 9)}${pad(String(y), 6)}${pad(String(r.length), 6)}${pad(fmt(mean(r)), 8)}` +
        `${counts.map((c) => pad(String(c), 8)).join("")}${pad(fmt(Math.min(...r)), 10)}${pad(fmt(Math.max(...r)), 9)}`,
      );
    }
  }
  say();

  say("=== 4. The twelve most extreme settlements per symbol ===");
  for (const [symbol, obs] of perSymbol) {
    const top = [...obs].sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate)).slice(0, 12);
    say(`  ${symbol}`);
    for (const o of top) {
      say(`    ${toISO(o.time)}  ${pad(fmt(o.rate * BPS), 9)} bps   step ${(o.intervalSec / HOUR).toFixed(2)}h`);
    }
  }
  say();

  /* --- clustering --- */

  say("=== 5. Clustering of extremes (|rate| > 20 bps) by month ===");
  for (const [symbol, obs] of perSymbol) {
    const ex = obs.filter((o) => Math.abs(o.rate * BPS) > 20);
    if (ex.length === 0) {
      say(`  ${symbol}: none`);
      continue;
    }
    const byMonth = new Map<string, number>();
    for (const o of ex) byMonth.set(monthOf(o.time), (byMonth.get(monthOf(o.time)) ?? 0) + 1);
    const rows = Array.from(byMonth.entries()).sort((a, b) => b[1] - a[1]);
    const distinctMonths = rows.length;
    const spanMonths = monthRange(monthOf(obs[0].time), monthOf(obs[obs.length - 1].time)).length;
    const top3 = rows.slice(0, 3).reduce((s, r) => s + r[1], 0);
    say(
      `  ${padR(symbol, 9)} ${pad(String(ex.length), 5)} events in ${distinctMonths}/${spanMonths} months; ` +
      `top-3 months hold ${((top3 / ex.length) * 100).toFixed(0)}% — ${rows.slice(0, 5).map(([m, c]) => `${m}:${c}`).join(" ")}`,
    );
  }
  say();

  /* --- forward returns --- */

  const QUANTILE_LABELS = ["Q1 lowest", "Q2", "Q3", "Q4", "Q5 highest"];

  say("=== 6. Forward price return after settlement, by rate quintile ===");
  say("    contrarian sign: short when rate > 0 (longs pay), long when rate < 0");
  for (const [symbol, obs] of perSymbol) {
    say(`  ${symbol}`);
    const buckets = rankBuckets(obs, 5);
    for (const h of args.horizonsH) {
      say(`    horizon ${h}h`);
      say(`      ${padR("bucket", 11)}${pad("n", 5)}${pad("rate", 8)}${pad("mean", 9)}${pad("NW se", 8)}${pad("t", 7)}${pad("NW t", 7)}${pad("CI lo", 9)}${pad("CI hi", 9)}`);
      for (let b = 0; b < buckets.length; b++) {
        const rows = buckets[b].filter((o) => o.fwd.has(h)).sort((a, b2) => a.time - b2.time);
        if (rows.length < 5) continue;
        const overlap = Math.ceil(h / 8);
        const contr = rows.map((o) => -Math.sign(o.rate) * o.fwd.get(h)!);
        const s = summarize(contr, overlap);
        const meanRate = mean(Float64Array.from(rows.map((o) => o.rate * BPS)));
        say(
          `      ${padR(QUANTILE_LABELS[b], 11)}${pad(String(s.n), 5)}${pad(fmt(meanRate), 8)}${pad(fmt(s.meanBps, 1), 9)}` +
          `${pad(fmt(s.nwSeBps, 1), 8)}${pad(fmt(s.t), 7)}${pad(fmt(s.nwT), 7)}${pad(fmt(s.lo95, 1), 9)}${pad(fmt(s.hi95, 1), 9)}`,
        );
      }
    }
  }
  say();

  say("=== 7. Forward return after ABSOLUTE extremes, pooled over symbols ===");
  say("    contrarian sign, mean in bps with 95% Newey-West interval");
  const pooled: Observation[] = [];
  for (const obs of perSymbol.values()) pooled.push(...obs);
  for (const thr of EXTREME_BPS) {
    const rows = pooled.filter((o) => Math.abs(o.rate * BPS) > thr);
    say(`  |rate| > ${thr} bps — ${rows.length} settlements`);
    if (rows.length < 5) continue;
    say(`      ${padR("horizon", 9)}${pad("n", 5)}${pad("rate", 8)}${pad("mean", 9)}${pad("NW se", 8)}${pad("t", 7)}${pad("NW t", 7)}${pad("p", 8)}${pad("CI lo", 9)}${pad("CI hi", 9)}`);
    for (const h of args.horizonsH) {
      const withFwd = rows.filter((o) => o.fwd.has(h)).sort((a, b) => a.time - b.time);
      if (withFwd.length < 5) continue;
      const overlap = Math.ceil(h / 8);
      const contr = withFwd.map((o) => -Math.sign(o.rate) * o.fwd.get(h)!);
      const s = summarize(contr, overlap);
      const meanRate = mean(Float64Array.from(withFwd.map((o) => o.rate * BPS)));
      say(
        `      ${padR(`${h}h`, 9)}${pad(String(s.n), 5)}${pad(fmt(meanRate), 8)}${pad(fmt(s.meanBps, 1), 9)}` +
        `${pad(fmt(s.nwSeBps, 1), 8)}${pad(fmt(s.t), 7)}${pad(fmt(s.nwT), 7)}${pad(fmt(s.p, 4), 8)}${pad(fmt(s.lo95, 1), 9)}${pad(fmt(s.hi95, 1), 9)}`,
      );
    }
  }
  say();

  say("=== 7b. Same thing at episode level — one observation per squeeze ===");
  say("    an episode ends after three quiet days; the t-test runs across episodes");
  for (const thr of EXTREME_BPS) {
    const rows = pooled.filter((o) => Math.abs(o.rate * BPS) > thr);
    if (rows.length < 5) continue;
    const eps = episodes(rows, 3 * 86_400);
    say(`  |rate| > ${thr} bps — ${rows.length} settlements in ${eps.length} episodes`);
    say(`      ${padR("horizon", 9)}${pad("eps", 5)}${pad("mean", 9)}${pad("se", 8)}${pad("t", 7)}${pad("p", 8)}${pad("CI lo", 9)}${pad("CI hi", 9)}${pad("win%", 7)}`);
    for (const h of args.horizonsH) {
      const perEpisode: number[] = [];
      for (const ep of eps) {
        const vals = ep.filter((o) => o.fwd.has(h)).map((o) => -Math.sign(o.rate) * o.fwd.get(h)!);
        if (vals.length > 0) perEpisode.push(mean(Float64Array.from(vals)));
      }
      if (perEpisode.length < 5) continue;
      const s = summarize(perEpisode, 0);
      const wins = perEpisode.filter((v) => v > 0).length;
      say(
        `      ${padR(`${h}h`, 9)}${pad(String(s.n), 5)}${pad(fmt(s.meanBps, 1), 9)}${pad(fmt(s.nwSeBps, 1), 8)}` +
        `${pad(fmt(s.nwT), 7)}${pad(fmt(s.p, 4), 8)}${pad(fmt(s.lo95, 1), 9)}${pad(fmt(s.hi95, 1), 9)}${pad(fmt((wins / s.n) * 100, 0), 7)}`,
      );
    }
  }
  say();

  /* --- momentum side: same but WITH the skew --- */

  say("=== 8. Same extremes, momentum sign (trade WITH the paying side) ===");
  for (const thr of [20, 50]) {
    const rows = pooled.filter((o) => Math.abs(o.rate * BPS) > thr);
    if (rows.length < 5) continue;
    say(`  |rate| > ${thr} bps`);
    for (const h of args.horizonsH) {
      const withFwd = rows.filter((o) => o.fwd.has(h));
      if (withFwd.length < 5) continue;
      const mom = withFwd.map((o) => Math.sign(o.rate) * o.fwd.get(h)!);
      const s = summarize(mom, Math.ceil(h / 8));
      say(`      ${padR(`${h}h`, 9)}${pad(String(s.n), 5)}${pad(fmt(s.meanBps, 1), 9)}${pad(fmt(s.nwT), 7)}   CI [${fmt(s.lo95, 1)}, ${fmt(s.hi95, 1)}]`);
    }
  }
  say();

  /* --- concentration --- */

  say("=== 9. Concentration of the contrarian payoff (|rate| > 20 bps, 24h horizon) ===");
  {
    const rows = pooled.filter((o) => Math.abs(o.rate * BPS) > 20 && o.fwd.has(24));
    if (rows.length >= 5) {
      const contributions = rows.map((o) => ({ o, v: -Math.sign(o.rate) * o.fwd.get(24)! * BPS }));
      const total = contributions.reduce((s, c) => s + c.v, 0);
      const sorted = [...contributions].sort((a, b) => b.v - a.v);
      const top3 = sorted.slice(0, 3).reduce((s, c) => s + c.v, 0);
      const top10 = sorted.slice(0, 10).reduce((s, c) => s + c.v, 0);
      say(`  n=${rows.length}, total ${fmt(total, 0)} bps, mean ${fmt(total / rows.length, 1)} bps`);
      say(`  top-3 events contribute ${fmt(top3, 0)} bps (${fmt((top3 / total) * 100, 0)}% of total)`);
      say(`  top-10 events contribute ${fmt(top10, 0)} bps (${fmt((top10 / total) * 100, 0)}% of total)`);
      say(`  best:  ${sorted.slice(0, 5).map((c) => `${toISO(c.o.time).slice(0, 10)} ${fmt(c.v, 0)}`).join(" | ")}`);
      say(`  worst: ${sorted.slice(-5).map((c) => `${toISO(c.o.time).slice(0, 10)} ${fmt(c.v, 0)}`).join(" | ")}`);
      const byYear = new Map<number, number>();
      for (const c of contributions) byYear.set(yearOf(c.o.time), (byYear.get(yearOf(c.o.time)) ?? 0) + c.v);
      say(`  by year: ${Array.from(byYear.entries()).sort().map(([y, v]) => `${y}:${fmt(v, 0)}`).join("  ")}`);
      const medianContribution = quantile(Float64Array.from(contributions.map((c) => c.v)), 0.5);
      say(`  median event ${fmt(medianContribution, 1)} bps — compare with 11 bps taker round trip`);
    }
  }
  say();

  /* --- carry --- */

  say("=== 10. Pure carry: hold the receiving side for one interval ===");
  say("    'accrual' is the rate collected; 'net' subtracts the price move against you");
  say(`  ${padR("symbol", 9)}${padR("bucket", 11)}${pad("n", 6)}${pad("rate", 8)}${pad("accrual", 9)}${pad("net", 9)}${pad("NW t", 7)}${pad("win%", 7)}`);
  for (const [symbol, obs] of perSymbol) {
    const buckets = rankBuckets(obs, 5);
    for (let b = 0; b < buckets.length; b++) {
      const rows = buckets[b].filter((o) => o.fwd.has(8)).sort((a, b2) => a.time - b2.time);
      if (rows.length < 5) continue;
      const net = rows.map((o) => Math.abs(o.rate) - Math.sign(o.rate) * o.fwd.get(8)!);
      const s = summarize(net, 1);
      const accrual = mean(Float64Array.from(rows.map((o) => Math.abs(o.rate) * BPS)));
      const wins = net.filter((v) => v > 0).length;
      say(
        `  ${padR(symbol, 9)}${padR(QUANTILE_LABELS[b], 11)}${pad(String(rows.length), 6)}` +
        `${pad(fmt(mean(Float64Array.from(rows.map((o) => o.rate * BPS)))), 8)}${pad(fmt(accrual), 9)}` +
        `${pad(fmt(s.meanBps, 1), 9)}${pad(fmt(s.nwT), 7)}${pad(fmt((wins / net.length) * 100, 0), 7)}`,
      );
    }
  }
  say();

  say("=== 11. Delta-neutral carry: how long to pay for the two legs ===");
  say("    A hedged carry needs a perp leg and an offsetting one: 4 fills, ~22 bps taker.");
  say("    Question: what does the accrual look like once you have to hold long enough.");
  for (const [symbol, obs] of perSymbol) {
    const ex = obs.filter((o) => Math.abs(o.rate * BPS) > 20);
    if (ex.length === 0) {
      say(`  ${padR(symbol, 9)} no settlement above 20 bps`);
      continue;
    }
    // Persistence: given an extreme, how much |rate| is collected over the next
    // k settlements assuming the sign does not flip against us.
    const byIndex = new Map<number, number>();
    obs.forEach((o, i) => byIndex.set(o.time, i));
    const horizons = [1, 3, 6, 9];
    const sums = horizons.map((k) => {
      const vals: number[] = [];
      for (const o of ex) {
        const i = byIndex.get(o.time)!;
        let acc = 0;
        let ok = true;
        for (let j = 0; j < k; j++) {
          const nxt = obs[i + j];
          if (!nxt) { ok = false; break; }
          acc += Math.sign(o.rate) * nxt.rate;
        }
        if (ok) vals.push(acc * BPS);
      }
      return { k, mean: mean(Float64Array.from(vals)), n: vals.length };
    });
    say(`  ${padR(symbol, 9)} n=${ex.length}  ` + sums.map((s) => `${s.k}x: ${fmt(s.mean, 1)} bps`).join("   "));
  }
  say();

  say("=== 12. Basis-hedged carry (long spot / short perp, or the mirror) ===");
  say("    Only BTC and ETH have a spot series. P&L = funding collected + basis convergence.");
  say("    Costs: perp round trip 11 bps taker, spot round trip 20 bps taker => 31 bps for the pair.");
  const HEDGE_COST_BPS = 31;
  for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
    const obs = perSymbol.get(symbol);
    if (!obs) continue;
    const spot = loadPrices(args.dataRoot, "spot", symbol);
    const perp = loadPrices(args.dataRoot, "linear", symbol);
    for (const thr of [5, 10, 20]) {
      const trigger = obs.filter((o) => Math.abs(o.rate * BPS) > thr);
      if (trigger.length < 5) continue;
      const byTime = new Map(obs.map((o, i) => [o.time, i]));
      for (const holds of [1, 3, 9]) {
        const gross: number[] = [];
        const kept: Observation[] = [];
        for (const o of trigger) {
          const i = byTime.get(o.time)!;
          const end = obs[i + holds];
          if (!end) continue;
          const sPerp0 = priceAt(perp, o.time);
          const sPerp1 = priceAt(perp, end.time);
          const sSpot0 = priceAt(spot, o.time);
          const sSpot1 = priceAt(spot, end.time);
          if (sPerp0 === null || sPerp1 === null || sSpot0 === null || sSpot1 === null) continue;
          let collected = 0;
          for (let j = 0; j < holds; j++) collected += Math.sign(o.rate) * obs[i + j].rate;
          // Short perp / long spot when rate > 0; the mirror when it is negative.
          const dir = -Math.sign(o.rate);
          const basis = dir * (Math.log(sPerp1 / sPerp0) - Math.log(sSpot1 / sSpot0));
          gross.push((collected + basis) * BPS);
          kept.push(o);
        }
        if (gross.length < 5) continue;
        const s = summarize(gross.map((v) => v / BPS), 0);
        const net = s.meanBps - HEDGE_COST_BPS;
        const byYear = new Map<number, number[]>();
        kept.forEach((o, i) => {
          const y = yearOf(o.time);
          const list = byYear.get(y);
          if (list) list.push(gross[i]);
          else byYear.set(y, [gross[i]]);
        });
        const yearText = Array.from(byYear.entries())
          .sort()
          .map(([y, v]) => `${y}:${fmt(mean(Float64Array.from(v)) - HEDGE_COST_BPS, 0)}(${v.length})`)
          .join(" ");
        say(
          `  ${padR(symbol, 9)}|rate|>${pad(String(thr), 3)}bps  hold ${pad(String(holds), 2)}x  n=${pad(String(s.n), 4)}  ` +
          `gross ${pad(fmt(s.meanBps, 1), 8)}  net ${pad(fmt(net, 1), 8)}  t ${pad(fmt(s.t), 6)}  net by year ${yearText}`,
        );
      }
    }
  }
  say();

  if (args.out) {
    const file = path.isAbsolute(args.out) ? args.out : path.join(reportsDir(args.dataRoot), args.out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${out.join("\n")}\n`);
    process.stderr.write(`written ${file}\n`);
  }
}

main();
