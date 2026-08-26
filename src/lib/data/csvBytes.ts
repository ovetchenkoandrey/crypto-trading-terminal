/**
 * Byte-level CSV scanning for the order-book datasets.
 *
 * A day of Tardis quotes is 120 MB of text and 1.5 million rows. Splitting that
 * into strings costs more in allocation and GC than the arithmetic we actually
 * want, so the calibration reads numbers straight out of the buffer and never
 * materialises a row. The helpers are deliberately dumb: no quoting, no escapes
 * — the exchange archives are plain comma-separated numbers, and anything that
 * is not is a format change we want to hear about, not silently absorb.
 */

const COMMA = 0x2c;
const LF = 0x0a;
const CR = 0x0d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;

export const MAX_FIELDS = 32;

export interface CsvCursor {
  /** Byte offset of the first character of each field in the current row. */
  starts: Int32Array;
  /** Byte offset one past the last character of each field. */
  ends: Int32Array;
  count: number;
}

export function createCursor(): CsvCursor {
  return { starts: new Int32Array(MAX_FIELDS), ends: new Int32Array(MAX_FIELDS), count: 0 };
}

/** Splits one line (already delimited) into the cursor. Returns the field count. */
export function splitRow(buf: Uint8Array, from: number, to: number, cur: CsvCursor): number {
  let n = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (buf[i] === COMMA) {
      if (n < MAX_FIELDS) {
        cur.starts[n] = start;
        cur.ends[n] = i;
      }
      n++;
      start = i + 1;
    }
  }
  if (n < MAX_FIELDS) {
    cur.starts[n] = start;
    cur.ends[n] = to;
  }
  n++;
  cur.count = Math.min(n, MAX_FIELDS);
  return n;
}

/**
 * Decimal parser for the numeric columns. Returns NaN on anything it does not
 * recognise so a malformed row is countable rather than quietly zero.
 *
 * Exponents are not supported on purpose: none of these archives use them, and
 * accepting them would mean accepting a column we did not expect.
 */
export function parseNumberSlice(buf: Uint8Array, start: number, end: number): number {
  let i = start;
  if (i >= end) return NaN;
  let sign = 1;
  if (buf[i] === MINUS) {
    sign = -1;
    i++;
  } else if (buf[i] === PLUS) {
    i++;
  }
  let value = 0;
  let digits = 0;
  for (; i < end; i++) {
    const c = buf[i];
    if (c < ZERO || c > NINE) break;
    value = value * 10 + (c - ZERO);
    digits++;
  }
  if (i < end && buf[i] === DOT) {
    i++;
    let scale = 1;
    for (; i < end; i++) {
      const c = buf[i];
      if (c < ZERO || c > NINE) break;
      value = value * 10 + (c - ZERO);
      scale *= 10;
      digits++;
    }
    value /= scale;
  }
  if (digits === 0 || i !== end) return NaN;
  return sign * value;
}

/** Byte-compare a field against an ASCII literal. Cheaper than decoding it. */
export function fieldEquals(buf: Uint8Array, start: number, end: number, literal: string): boolean {
  if (end - start !== literal.length) return false;
  for (let i = 0; i < literal.length; i++) {
    if (buf[start + i] !== literal.charCodeAt(i)) return false;
  }
  return true;
}

export function fieldString(buf: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}

export interface RowRange {
  from: number;
  to: number;
}

/** Offsets of the first line, so a caller can check the header before scanning. */
export function firstLine(buf: Uint8Array): RowRange {
  let to = buf.indexOf(LF);
  if (to === -1) to = buf.length;
  let end = to;
  if (end > 0 && buf[end - 1] === CR) end--;
  return { from: 0, to: end };
}

/** Reads the header row into plain strings. Used only once per file. */
export function headerFields(buf: Uint8Array): string[] {
  const cur = createCursor();
  const line = firstLine(buf);
  const n = splitRow(buf, line.from, line.to, cur);
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, MAX_FIELDS); i++) out.push(fieldString(buf, cur.starts[i], cur.ends[i]));
  return out;
}

export function expectHeader(buf: Uint8Array, expected: readonly string[], what: string): void {
  const got = headerFields(buf);
  const same = got.length === expected.length && expected.every((c, i) => got[i] === c);
  if (!same) {
    throw new Error(`${what}: unexpected header [${got.join(",")}], expected [${expected.join(",")}]`);
  }
}

/**
 * Calls `onRow` for every data line after the header. The cursor is reused, so
 * the callback must read what it needs before returning.
 */
export function forEachDataRow(
  buf: Uint8Array,
  onRow: (cur: CsvCursor) => void,
  cur: CsvCursor = createCursor(),
): number {
  const len = buf.length;
  let i = firstLine(buf).to;
  while (i < len && buf[i] !== LF) i++;
  i++;
  let rows = 0;
  while (i < len) {
    let j = i;
    while (j < len && buf[j] !== LF) j++;
    let end = j;
    if (end > i && buf[end - 1] === CR) end--;
    if (end > i) {
      splitRow(buf, i, end, cur);
      onRow(cur);
      rows++;
    }
    i = j + 1;
  }
  return rows;
}
