import { describe, expect, it } from "vitest";
import {
  createCursor,
  expectHeader,
  fieldEquals,
  fieldString,
  forEachDataRow,
  headerFields,
  parseNumberSlice,
  splitRow,
} from "./csvBytes";

const buf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

function num(s: string): number {
  const b = buf(s);
  return parseNumberSlice(b, 0, b.length);
}

describe("parseNumberSlice", () => {
  it("reads integers and decimals", () => {
    expect(num("0")).toBe(0);
    expect(num("42")).toBe(42);
    expect(num("104566.1")).toBeCloseTo(104566.1, 9);
    expect(num("-5")).toBe(-5);
    expect(num("+3")).toBe(3);
    expect(num("0.016")).toBeCloseTo(0.016, 12);
  });

  it("keeps full precision on microsecond timestamps", () => {
    expect(num("1748736000078000")).toBe(1748736000078000);
  });

  it("returns NaN on anything it does not recognise", () => {
    expect(num("")).toBeNaN();
    expect(num("abc")).toBeNaN();
    expect(num("1.2.3")).toBeNaN();
    expect(num("1e5")).toBeNaN();
    expect(num("12 ")).toBeNaN();
    expect(num("-")).toBeNaN();
  });
});

describe("splitRow", () => {
  it("records field boundaries without allocating strings", () => {
    const b = buf("a,bb,,ccc");
    const cur = createCursor();
    expect(splitRow(b, 0, b.length, cur)).toBe(4);
    expect(fieldString(b, cur.starts[0], cur.ends[0])).toBe("a");
    expect(fieldString(b, cur.starts[1], cur.ends[1])).toBe("bb");
    expect(cur.ends[2] - cur.starts[2]).toBe(0);
    expect(fieldString(b, cur.starts[3], cur.ends[3])).toBe("ccc");
  });
});

describe("fieldEquals", () => {
  it("matches by bytes", () => {
    const b = buf("x,sell,y");
    const cur = createCursor();
    splitRow(b, 0, b.length, cur);
    expect(fieldEquals(b, cur.starts[1], cur.ends[1], "sell")).toBe(true);
    expect(fieldEquals(b, cur.starts[1], cur.ends[1], "buy")).toBe(false);
    expect(fieldEquals(b, cur.starts[1], cur.ends[1], "sel")).toBe(false);
  });
});

describe("forEachDataRow", () => {
  it("skips the header and tolerates CRLF and a missing final newline", () => {
    const b = buf("a,b\r\n1,2\r\n3,4");
    const seen: number[][] = [];
    const rows = forEachDataRow(b, (c) => {
      seen.push([parseNumberSlice(b, c.starts[0], c.ends[0]), parseNumberSlice(b, c.starts[1], c.ends[1])]);
    });
    expect(rows).toBe(2);
    expect(seen).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("ignores blank lines", () => {
    const b = buf("a\n1\n\n2\n");
    expect(forEachDataRow(b, () => undefined)).toBe(2);
  });

  it("handles a file with only a header", () => {
    expect(forEachDataRow(buf("a,b\n"), () => undefined)).toBe(0);
  });
});

describe("header checks", () => {
  it("reads the header", () => {
    expect(headerFields(buf("one,two,three\n1,2,3\n"))).toEqual(["one", "two", "three"]);
  });

  it("throws when the columns moved", () => {
    expect(() => expectHeader(buf("b,a\n"), ["a", "b"], "sample")).toThrow(/unexpected header/);
    expect(() => expectHeader(buf("a,b\n"), ["a", "b"], "sample")).not.toThrow();
  });
});
