import fs from "node:fs";
import path from "node:path";
import { createCandleStore, type CandleStore } from "./candleStore.ts";
import { intervalSeconds } from "./interval.ts";
import { expectedBarsInMonth, monthEndSec, monthRange, monthStartSec, type MonthKey } from "./months.ts";
import type { DatasetKey } from "./paths.ts";
import { validateCandles, type MonthInput, type QualityReport, type SourceSpan, type ValidateOptions } from "./validate.ts";

/** Reads a dataset back off disk and runs the quality checks over it. */
export interface BuildReportOptions extends Partial<Omit<ValidateOptions, "intervalSec" | "fromSec" | "toSec" | "dataset" | "months">> {
  store?: CandleStore;
  /** Clips the expected-bar count of the running month. Defaults to now. */
  nowSec?: number;
}

export function buildQualityReport(
  root: string,
  key: DatasetKey,
  from: MonthKey,
  to: MonthKey,
  opts: BuildReportOptions = {},
): QualityReport {
  const store = opts.store ?? createCandleStore(root);
  const step = intervalSeconds(key.interval);
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const fromSec = monthStartSec(from);
  const toSec = Math.min(monthEndSec(to) - step, nowSec - (nowSec % step) - step);

  const months: MonthInput[] = [];
  const sourceSpans: SourceSpan[] = [];
  for (const month of monthRange(from, to)) {
    const status = store.inspectMonth(key, month);
    // A month the store refuses to read contributes nothing, whatever its
    // sidecar claims — reporting the claimed count would hide the damage.
    const readable = status.state === "ok" || status.state === "trailing";
    months.push({
      month,
      present: status.state !== "missing",
      state: status.state,
      sources: readable ? status.meta?.sources ?? [] : [],
      count: readable ? status.meta?.count ?? 0 : 0,
      complete: status.meta?.complete ?? false,
      expected: expectedBarsInMonth(month, step, toSec + step),
    });
    if (readable) {
      for (const span of status.meta?.sourceSpans ?? []) sourceSpans.push(span);
    }
  }

  const candles = store.readRange(key, fromSec, toSec);
  return validateCandles(candles, {
    ...opts,
    intervalSec: step,
    fromSec,
    toSec,
    dataset: { market: key.market, symbol: key.symbol, interval: key.interval },
    months,
    sourceSpans,
  });
}

/** Writes both faces of a report: JSON to gate on, text to read. */
export function writeReportFiles(
  dir: string,
  baseName: string,
  report: unknown,
  text: string,
): { json: string; txt: string } {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, `${baseName}.json`);
  const txt = path.join(dir, `${baseName}.txt`);
  fs.writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(txt, `${text}\n`);
  return { json, txt };
}
