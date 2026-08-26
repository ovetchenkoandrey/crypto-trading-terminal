import { COST_FLOORS, TAKER_ROUND_TRIP_BPS } from "./costs.ts";
import { familywiseZThreshold } from "./multipleTesting.ts";
import type { StudyResult, SymbolStudy } from "./study.ts";

/** Plain-text rendering of a study, for the console and for a report file. */

function pad(text: string, width: number, right = true): string {
  const s = String(text);
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return right ? fill + s : s + fill;
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[], leftFirst = true): string =>
    cells.map((c, i) => pad(c ?? "", widths[i], !(leftFirst && i === 0))).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map((r) => line(r))].join("\n");
}

const n2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "--");
const n3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : "--");
const n4 = (v: number): string => (Number.isFinite(v) ? v.toFixed(4) : "--");
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "--");

function pFmt(p: number): string {
  if (!Number.isFinite(p)) return "--";
  if (p >= 0.001) return p.toFixed(4);
  if (p === 0) return "<1e-300";
  return p.toExponential(1);
}

function utc(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function moveTable(s: SymbolStudy): string {
  const rows = s.horizons.map((h) => [
    h.interval,
    String(h.returns),
    n2(h.move.medianAbsBps),
    n2(h.move.meanAbsBps),
    n2(h.move.p90Bps),
    n2(h.move.stdevBps),
    n2(h.move.meanRangeBps),
    n2(h.move.costs[1].costOverMedian),
    pct(h.move.costs[1].shareAboveCost),
    n3(h.move.costs[1].breakEvenAtMedian),
    n3(h.move.costs[0].breakEvenAtMedian),
    n2(h.move.oracleDailyPct),
    n2((h.move.barsPerDay * TAKER_ROUND_TRIP_BPS) / 100),
    n2(h.move.oracleDailyPct / ((h.move.barsPerDay * TAKER_ROUND_TRIP_BPS) / 100)),
  ]);
  // The last three columns are the ceiling argument: a strategy that knew every
  // bar in advance would earn "oracle %/d" and pay "fees %/d" for the privilege.
  // Where the ratio is below one, no signal at that timeframe can pay taker fees.
  return table(
    [
      "tf", "bars", "med|r| bp", "mean|r| bp", "p90 bp", "sd bp", "range bp",
      "fee/med", "above fee", "BE hit", "BE maker", "oracle %/d", "fees %/d", "ratio",
    ],
    rows,
  );
}

function autocorrTable(s: SymbolStudy, winsorized = false): string {
  const lags = [1, 2, 3, 5, 10, 20];
  const rows = s.horizons.map((h) => {
    const source = winsorized ? h.autocorrWinsorized : h.autocorr;
    const cells = lags.map((lag) => {
      const r = source.find((a) => a.lag === lag);
      return r ? `${n4(r.rho)}${Math.abs(r.z) > 1.96 ? "*" : " "}` : "--";
    });
    return [h.interval, String(h.returns), ...cells];
  });
  return table(["tf", "n", ...lags.map((l) => `rho(${l})`)], rows);
}

function edgeTable(s: SymbolStudy): string {
  const rows = s.horizons.map((h) => {
    const r1 = h.autocorr.find((a) => a.lag === 1);
    return [
      h.interval,
      r1 ? n4(r1.rho) : "--",
      r1 ? n2(r1.z) : "--",
      n2(h.momentum.edgeBps),
      n2(h.momentum.t),
      h.forecast ? n4(h.forecast.outOfSampleR2) : "--",
      h.forecast ? n2(h.forecast.testEdgeBps) : "--",
      h.forecast ? n2(h.forecast.testEdgeT) : "--",
      n2(TAKER_ROUND_TRIP_BPS),
      n4(h.rhoFirstHalf),
      n4(h.rhoSecondHalf),
    ];
  });
  return table(
    ["tf", "rho1", "z", "mom bp", "t", "OOS R2", "fcst bp", "t", "fee bp", "rho1 h1", "rho1 h2"],
    rows,
  );
}

function reversalTable(s: SymbolStudy): string {
  const rows = s.horizons.flatMap((h) =>
    h.reversal.map((r) => [
      h.interval,
      r.label,
      String(r.n),
      n2(r.meanTriggerBps),
      n3(r.reversalBps),
      n3(r.seBps),
      n2(r.t),
      pct(r.hitRate),
      n3(r.reversalBps - TAKER_ROUND_TRIP_BPS),
    ]),
  );
  return table(["tf", "decile", "n", "trigger bp", "fade bp", "se", "t", "hit", "vs fee"], rows);
}

function tailTable(s: SymbolStudy): string {
  const rows = s.tail.map((r) => [
    `${(r.percentile * 100).toFixed(2)}%`,
    n1(r.thresholdBps),
    String(r.horizon),
    String(r.n),
    n2(r.reversalBps),
    `[${n2(r.ciLowBps)}, ${n2(r.ciHighBps)}]`,
    n2(r.t),
    pct(r.hitRate),
    n2(r.reversalBps - TAKER_ROUND_TRIP_BPS),
  ]);
  return table(["trigger", "thresh bp", "hold", "n", "fade bp", "95% CI", "t", "hit", "vs fee"], rows);
}

function sessionTable(s: SymbolStudy): string {
  const rows = s.calendar.sessions.map((x) => [
    x.label,
    String(x.returns),
    n4(x.rho1),
    n2(x.z),
    pFmt(x.p),
    n2(x.topDecileTriggerBps),
    n3(x.topDecileReversalBps),
    n2(x.topDecileT),
  ]);
  return table(["session", "n", "rho1", "z", "p", "D10 trigger bp", "D10 fade bp", "t"], rows);
}

function vrTable(s: SymbolStudy): string {
  const qs = [2, 4, 8, 16, 32, 64];
  const rows = s.horizons.map((h) => {
    const cells = qs.map((q) => {
      const r = h.varianceRatio.find((v) => v.q === q);
      return r ? `${n3(r.vr)}${Math.abs(r.zHeteroskedastic) > 1.96 ? "*" : " "}` : "--";
    });
    return [h.interval, ...cells];
  });
  return table(["tf", ...qs.map((q) => `VR(${q})`)], rows);
}

function vrZTable(s: SymbolStudy): string {
  const rows = s.horizons.flatMap((h) =>
    h.varianceRatio.map((v) => [
      h.interval,
      String(v.q),
      n3(v.vr),
      `[${n3(v.ciLow)}, ${n3(v.ciHigh)}]`,
      n2(v.zHeteroskedastic),
      pFmt(v.pHeteroskedastic),
      n2(v.zHomoskedastic),
    ]),
  );
  return table(["tf", "q", "VR", "95% CI", "z*", "p*", "z (homosk.)"], rows);
}

function hourTable(s: SymbolStudy): string {
  const rows = s.calendar.hourly.map((g, i) => {
    const aux = s.calendar.hourAux[i];
    return [
      g.label,
      String(g.n),
      n3(g.meanBps),
      n2(g.t),
      n2(g.stdevBps),
      n3(g.volRatioVsRest),
      n1(aux.meanVolume),
      n2(aux.meanRangeBps),
      n2(g.tVsRest),
      n2(g.tVolVsRest),
    ];
  });
  return table(
    ["hour", "n", "mean bp", "t", "sd bp", "sd ratio", "volume", "range bp", "t vs rest", "t vol"],
    rows,
  );
}

const n1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "--");

function weekdayTable(s: SymbolStudy): string {
  const rows = s.calendar.weekday.map((g) => [
    g.label,
    String(g.n),
    n3(g.meanBps),
    n2(g.t),
    n2(g.stdevBps),
    n3(g.volRatioVsRest),
    n2(g.tVolVsRest),
  ]);
  return table(["day", "n", "mean bp", "t", "sd bp", "sd ratio", "t vol"], rows);
}

function flagTable(s: SymbolStudy): string {
  const rows = [s.calendar.deadHours, s.calendar.weekend, s.calendar.monthStart].map((g) => [
    g.label,
    String(g.n),
    n3(g.meanBps),
    `[${n3(g.ciLowBps)}, ${n3(g.ciHighBps)}]`,
    n2(g.t),
    n3(g.volRatioVsRest),
    n2(g.tVolVsRest),
    pFmt(g.pVsRest),
  ]);
  return table(["slice", "n", "mean bp", "95% CI", "t", "sd ratio", "t vol", "p vs rest"], rows);
}

function volatilityBlock(s: SymbolStudy): string {
  const v = s.volatility;
  const absRows = v.absAutocorr1m.map((a) => ["1m |r|", String(a.lag), n4(a.rho), n2(a.z)]);
  const absRows1h = v.absAutocorr1h.map((a) => ["1h |r|", String(a.lag), n4(a.rho), n2(a.z)]);
  const har = table(
    ["series", "in-sample R2", "OOS R2", "test corr", "periods"],
    [
      ["hourly realized vol", n3(v.hourlyHar.inSampleR2), n3(v.hourlyHar.outOfSampleR2), n3(v.hourlyHar.testCorrelation), String(v.hourlyHar.periods)],
      ["daily realized vol", n3(v.dailyHar.inSampleR2), n3(v.dailyHar.outOfSampleR2), n3(v.dailyHar.testCorrelation), String(v.dailyHar.periods)],
      ["daily direction", "--", n4(v.dailyDirectionR2), "--", "--"],
    ],
  );
  const regime = table(
    ["series", "P(low|low)", "P(mid|mid)", "P(high|high)", "base"],
    [
      ["hourly", n3(v.hourlyRegimes.persistence[0]), n3(v.hourlyRegimes.persistence[1]), n3(v.hourlyRegimes.persistence[2]), n3(v.hourlyRegimes.base[0])],
      ["daily", n3(v.dailyRegimes.persistence[0]), n3(v.dailyRegimes.persistence[1]), n3(v.dailyRegimes.persistence[2]), n3(v.dailyRegimes.base[0])],
    ],
  );
  const conditional = table(
    ["today's vol tercile", "mean next-day realized vol"],
    v.dailyConditional.map((c, i) => [["low", "mid", "high"][i], n4(c)]),
  );
  return [
    table(["series", "lag", "rho", "z"], [...absRows, ...absRows1h]),
    "",
    har,
    "",
    regime,
    "",
    conditional,
  ].join("\n");
}

function fundingBlock(s: SymbolStudy): string {
  if (!s.funding) return "no funding history in range";
  const f = s.funding;
  const head = `settlements ${f.events}, interval ${f.intervalSec / 3600}h, rate mean ${n2(f.meanRateBps)} bp, range ${n2(f.minRateBps)}..${n2(f.maxRateBps)} bp`;
  const windows = table(
    ["window", "n", "mean bp", "t", "p", "median bp"],
    f.windows.map((w) => [w.label, String(w.n), n3(w.meanBps), n2(w.t), pFmt(w.p), n3(w.medianBps)]),
  );
  const carry = table(
    ["bucket", "n", "rate bp", "fwd bp", "carry bp", "t", "win", "vs fee"],
    f.carry.map((c) => [
      c.label,
      String(c.n),
      n2(c.meanRateBps),
      n2(c.meanForwardBps),
      n2(c.carryBps),
      n2(c.carryT),
      pct(c.winRate),
      n2(c.carryBps - TAKER_ROUND_TRIP_BPS),
    ]),
  );
  return [head, "", windows, "", carry].join("\n");
}

export function formatSymbol(s: SymbolStudy): string {
  const out: string[] = [];
  out.push(`=== ${s.symbol} (${s.market}) ===`);
  out.push(`${utc(s.fromSec)} .. ${utc(s.toSec)} UTC, ${s.minuteBars} minute bars, coverage ${pct(s.coverage)}`);
  out.push("");
  out.push("-- move size vs the 11 bp taker round trip --");
  out.push(moveTable(s));
  out.push("");
  out.push("-- autocorrelation of returns (* = |z| > 1.96 on the robust standard error) --");
  out.push(autocorrTable(s));
  out.push("");
  out.push("-- same, on returns winsorized at their 0.1% tails --");
  out.push(autocorrTable(s, true));
  out.push("");
  out.push("-- predictability translated into basis points --");
  out.push(edgeTable(s));
  out.push("");
  out.push("-- fading the previous bar, by size of that bar (1m deciles are the row that matters) --");
  out.push(reversalTable(s));
  out.push("");
  out.push("-- fading the most extreme minutes, held for several minutes --");
  out.push(tailTable(s));
  out.push("");
  out.push("-- serial structure measured inside a session, minute returns --");
  out.push(sessionTable(s));
  out.push("");
  out.push("-- variance ratio (* = robust z beyond 1.96) --");
  out.push(vrTable(s));
  out.push("");
  out.push(vrZTable(s));
  out.push("");
  out.push("-- hour of day, UTC, on minute returns --");
  out.push(hourTable(s));
  out.push("");
  out.push("-- weekday, UTC, on minute returns --");
  out.push(weekdayTable(s));
  out.push("");
  out.push("-- calendar slices --");
  out.push(flagTable(s));
  out.push("");
  out.push("-- volatility --");
  out.push(volatilityBlock(s));
  out.push("");
  out.push("-- funding --");
  out.push(fundingBlock(s));
  return out.join("\n");
}

export function formatStudy(result: StudyResult): string {
  const out: string[] = [];
  out.push(`market study generated ${result.generatedAt}`);
  out.push(`range ${utc(result.fromSec)} .. ${utc(result.toSec)} UTC, market ${result.market}`);
  out.push(`cost floors: ${COST_FLOORS.map((c) => `${c.label} ${c.roundTripBps} bp`).join(", ")}`);
  out.push("");
  for (const s of result.symbols) {
    out.push(formatSymbol(s));
    out.push("");
  }
  if (result.leadLag) {
    out.push(`-- ${result.leadLag.a} against ${result.leadLag.b}, aligned minutes --`);
    out.push(
      table(
        ["lag", "n", "corr", "z", "edge bp", "t"],
        result.leadLag.rows.map((r) => [String(r.lag), String(r.n), n4(r.corr), n2(r.z), n3(r.edgeBps), n2(r.edgeT)]),
      ),
    );
    out.push("");
  }

  const family = result.adjusted.length;
  const threshold = familywiseZThreshold(family);
  const survivors = result.adjusted.filter((a) => a.bonferroni < 0.05).sort((a, b) => a.p - b.p);
  out.push(`-- multiple testing: ${family} tests in the family, Bonferroni |z| threshold ${n2(threshold)} --`);
  out.push(`${survivors.length} tests survive Bonferroni at 5%; ${result.adjusted.filter((a) => a.bh < 0.05).length} survive Benjamini-Hochberg`);
  out.push("");
  out.push(
    table(
      ["test", "p", "bonferroni", "BH q"],
      survivors.slice(0, 40).map((a) => [a.label, pFmt(a.p), pFmt(a.bonferroni), pFmt(a.bh)]),
    ),
  );
  return out.join("\n");
}
