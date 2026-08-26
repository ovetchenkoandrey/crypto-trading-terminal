import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createCursor,
  expectHeader,
  fieldEquals,
  forEachDataRow,
  parseNumberSlice,
} from "./csvBytes.ts";
import { fetchBuffer, type HttpOptions } from "./http.ts";

/**
 * Tardis publishes one free sample day per month per dataset — the first of the
 * month — at a stable URL with no key and no registration:
 *
 *   https://datasets.tardis.dev/v1/bybit/quotes/2025/06/01/BTCUSDT.csv.gz
 *
 * Two years of samples is 24 full days of real L1 book and real trade flow for
 * the venue we actually trade on. That is what the cost model gets calibrated
 * against; everything else we have is bar data, and bars cannot answer "did the
 * queue reach us".
 *
 * The server answers GET but returns 404 to HEAD and 403 to ranged requests, so
 * files are fetched whole and cached on disk.
 */

export const TARDIS_BASE = "https://datasets.tardis.dev/v1";

export type TardisDataType = "quotes" | "trades" | "book_snapshot_25" | "derivative_ticker";

export interface TardisRef {
  exchange: string;
  dataType: TardisDataType;
  symbol: string;
  /** ISO date, YYYY-MM-DD. Only the first of a month is free. */
  date: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(date: string): { y: string; m: string; d: string } {
  const match = DATE_RE.exec(String(date ?? ""));
  if (!match) throw new Error(`bad date "${date}", expected YYYY-MM-DD`);
  return { y: match[1], m: match[2], d: match[3] };
}

export function isFreeSampleDate(date: string): boolean {
  return parseIsoDate(date).d === "01";
}

export function tardisUrl(ref: TardisRef, base = TARDIS_BASE): string {
  const { y, m, d } = parseIsoDate(ref.date);
  return [base.replace(/\/+$/, ""), ref.exchange, ref.dataType, y, m, d, `${ref.symbol}.csv.gz`].join("/");
}

export function tardisCachePath(root: string, ref: TardisRef): string {
  return path.join(root, "orderbook", "tardis", ref.exchange, ref.dataType, `${ref.symbol}-${ref.date}.csv.gz`);
}

/** First-of-month dates covering [fromMonth, toMonth] inclusive, "YYYY-MM". */
export function firstOfMonthDates(fromMonth: string, toMonth: string): string[] {
  const parse = (s: string): [number, number] => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(s ?? ""));
    if (!m) throw new Error(`bad month "${s}", expected YYYY-MM`);
    return [Number(m[1]), Number(m[2])];
  };
  const [fy, fm] = parse(fromMonth);
  const [ty, tm] = parse(toMonth);
  const out: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export interface DownloadOptions extends HttpOptions {
  baseUrl?: string;
  /** Refetch even when the cache file already exists. */
  force?: boolean;
  /** Never hit the network: a missing sample is an error, not a download. */
  offline?: boolean;
}

export interface DownloadResult {
  ref: TardisRef;
  url: string;
  file: string;
  bytes: number;
  fromCache: boolean;
}

export async function downloadTardisSample(
  root: string,
  ref: TardisRef,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const url = tardisUrl(ref, opts.baseUrl ?? TARDIS_BASE);
  const file = tardisCachePath(root, ref);
  if (!opts.force && fs.existsSync(file)) {
    return { ref, url, file, bytes: fs.statSync(file).size, fromCache: true };
  }
  if (opts.offline) throw new Error(`${file}: not cached and --offline was requested`);
  const buf = await fetchBuffer(url, opts);
  // A missing sample comes back as an HTML error page rather than a 404 body.
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    throw new Error(`${url}: response is not gzip (${buf.length} bytes)`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { ref, url, file, bytes: buf.length, fromCache: false };
}

/* ── parsed days ──────────────────────────────────────────────────────────── */

/**
 * Columnar day of top-of-book. Typed arrays rather than objects: 1.5 million
 * rows as objects is a quarter of a gigabyte of heap and a GC pause per day.
 * `ts` is exchange time in **milliseconds** (the archives carry microseconds).
 */
export interface QuoteDay {
  n: number;
  ts: Float64Array;
  bid: Float64Array;
  bidAmt: Float64Array;
  ask: Float64Array;
  askAmt: Float64Array;
  malformed: number;
}

export interface TradeDay {
  n: number;
  ts: Float64Array;
  price: Float64Array;
  amount: Float64Array;
  /** 1 when the aggressor was a seller (the trade hit the bid). */
  sell: Uint8Array;
  malformed: number;
}

export const QUOTES_HEADER = [
  "exchange",
  "symbol",
  "timestamp",
  "local_timestamp",
  "ask_amount",
  "ask_price",
  "bid_price",
  "bid_amount",
] as const;

export const TRADES_HEADER = [
  "exchange",
  "symbol",
  "timestamp",
  "local_timestamp",
  "id",
  "side",
  "price",
  "amount",
] as const;

function countLines(buf: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return n + 1;
}

export function parseQuotesCsv(buf: Uint8Array): QuoteDay {
  expectHeader(buf, QUOTES_HEADER, "tardis quotes");
  const cap = countLines(buf);
  const day: QuoteDay = {
    n: 0,
    ts: new Float64Array(cap),
    bid: new Float64Array(cap),
    bidAmt: new Float64Array(cap),
    ask: new Float64Array(cap),
    askAmt: new Float64Array(cap),
    malformed: 0,
  };
  const cur = createCursor();
  forEachDataRow(
    buf,
    (c) => {
      if (c.count < 8) {
        day.malformed++;
        return;
      }
      const ts = parseNumberSlice(buf, c.starts[2], c.ends[2]);
      const askAmt = parseNumberSlice(buf, c.starts[4], c.ends[4]);
      const ask = parseNumberSlice(buf, c.starts[5], c.ends[5]);
      const bid = parseNumberSlice(buf, c.starts[6], c.ends[6]);
      const bidAmt = parseNumberSlice(buf, c.starts[7], c.ends[7]);
      if (!(ts > 0) || !(ask > 0) || !(bid > 0) || !(askAmt >= 0) || !(bidAmt >= 0)) {
        day.malformed++;
        return;
      }
      const i = day.n++;
      day.ts[i] = ts / 1000;
      day.bid[i] = bid;
      day.bidAmt[i] = bidAmt;
      day.ask[i] = ask;
      day.askAmt[i] = askAmt;
    },
    cur,
  );
  return day;
}

export function parseTradesCsv(buf: Uint8Array): TradeDay {
  expectHeader(buf, TRADES_HEADER, "tardis trades");
  const cap = countLines(buf);
  const day: TradeDay = {
    n: 0,
    ts: new Float64Array(cap),
    price: new Float64Array(cap),
    amount: new Float64Array(cap),
    sell: new Uint8Array(cap),
    malformed: 0,
  };
  const cur = createCursor();
  forEachDataRow(
    buf,
    (c) => {
      if (c.count < 8) {
        day.malformed++;
        return;
      }
      const ts = parseNumberSlice(buf, c.starts[2], c.ends[2]);
      const price = parseNumberSlice(buf, c.starts[6], c.ends[6]);
      const amount = parseNumberSlice(buf, c.starts[7], c.ends[7]);
      const isSell = fieldEquals(buf, c.starts[5], c.ends[5], "sell");
      const isBuy = fieldEquals(buf, c.starts[5], c.ends[5], "buy");
      if (!(ts > 0) || !(price > 0) || !(amount > 0) || (!isSell && !isBuy)) {
        day.malformed++;
        return;
      }
      const i = day.n++;
      day.ts[i] = ts / 1000;
      day.price[i] = price;
      day.amount[i] = amount;
      day.sell[i] = isSell ? 1 : 0;
    },
    cur,
  );
  return day;
}

export function readQuoteDay(file: string): QuoteDay {
  return parseQuotesCsv(gunzipSync(fs.readFileSync(file)));
}

export function readTradeDay(file: string): TradeDay {
  return parseTradesCsv(gunzipSync(fs.readFileSync(file)));
}
