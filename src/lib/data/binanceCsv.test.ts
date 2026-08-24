import { describe, expect, it } from "vitest";
import { detectTimeUnit, detectTimeUnitFromSamples, parseKlineCsv, toSeconds } from "./binanceCsv.ts";

const HEADER = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore";

function row(openTimeRaw: string | number, close = "73659.50"): string {
  return `${openTimeRaw},73653.20,73659.60,73620.00,${close},48.353,1780272059999,3561022.12150,2445,21.773,1603482.46490,0`;
}

describe("binanceCsv", () => {
  it("parses the futures format with a header row", () => {
    const text = [HEADER, row(1780272000000), row(1780272060000), ""].join("\n");
    const res = parseKlineCsv(text);
    expect(res.header?.[0]).toBe("open_time");
    expect(res.timeUnit).toBe("ms");
    expect(res.rows).toBe(2);
    expect(res.malformed).toBe(0);
    expect(res.candles).toEqual([
      { time: 1780272000, open: 73653.2, high: 73659.6, low: 73620, close: 73659.5, volume: 48.353 },
      { time: 1780272060, open: 73653.2, high: 73659.6, low: 73620, close: 73659.5, volume: 48.353 },
    ]);
  });

  it("parses the older headerless format", () => {
    const res = parseKlineCsv([row(1780272000000), row(1780272060000)].join("\n"));
    expect(res.header).toBeNull();
    expect(res.candles).toHaveLength(2);
    expect(res.candles[0].time).toBe(1780272000);
  });

  it("converts the microsecond timestamps Binance switched spot to in 2025", () => {
    const res = parseKlineCsv([HEADER, row(1780272000000000), row(1780272060000000)].join("\n"));
    expect(res.timeUnit).toBe("us");
    expect(res.candles[0].time).toBe(1780272000);
    expect(res.candles[1].time).toBe(1780272060);
  });

  it("classifies the timestamp magnitude", () => {
    expect(detectTimeUnit(1780272000)).toBe("s");
    expect(detectTimeUnit(1780272000000)).toBe("ms");
    expect(detectTimeUnit(1780272000000000)).toBe("us");
    expect(toSeconds(1780272000999, "ms")).toBe(1780272000);
    expect(toSeconds(1780272000999999, "us")).toBe(1780272000);
    expect(toSeconds(1780272000, "s")).toBe(1780272000);
  });

  it("counts malformed rows instead of throwing", () => {
    const text = [HEADER, row(1780272000000), "garbage,row", "1780272060000,x,y,z,w,v,,,,,,", row(1780272120000)].join("\n");
    const res = parseKlineCsv(text);
    expect(res.candles).toHaveLength(2);
    expect(res.malformed).toBe(2);
    expect(res.malformedSamples).toHaveLength(2);
  });

  it("drops timestamps outside a sane epoch window", () => {
    const res = parseKlineCsv([HEADER, row(1), row(1780272000000), row(1780272060000)].join("\n"));
    expect(res.timeUnit).toBe("ms");
    expect(res.candles.map((c) => c.time)).toEqual([1780272000, 1780272060]);
    expect(res.malformed).toBe(1);
  });

  it("does not let one bad row decide the unit for the whole file", () => {
    const good = Array.from({ length: 20 }, (_, i) => row(1780272000000 + i * 60000));
    const res = parseKlineCsv([HEADER, row(3), ...good].join("\n"));
    expect(res.timeUnit).toBe("ms");
    expect(res.candles).toHaveLength(20);
    expect(res.malformed).toBe(1);
    expect(detectTimeUnitFromSamples([3, 1780272000000, 1780272060000])).toBe("ms");
    expect(detectTimeUnitFromSamples([])).toBe("ms");
  });

  it("handles CRLF line endings and a trailing newline", () => {
    const res = parseKlineCsv(`${HEADER}\r\n${row(1780272000000)}\r\n${row(1780272060000)}\r\n`);
    expect(res.candles).toHaveLength(2);
    expect(res.malformed).toBe(0);
  });

  it("returns candles sorted by time", () => {
    const res = parseKlineCsv([HEADER, row(1780272120000), row(1780272000000), row(1780272060000)].join("\n"));
    expect(res.candles.map((c) => c.time)).toEqual([1780272000, 1780272060, 1780272120]);
  });

  it("returns nothing for an empty file", () => {
    const res = parseKlineCsv("");
    expect(res.candles).toEqual([]);
    expect(res.rows).toBe(0);
  });
});
