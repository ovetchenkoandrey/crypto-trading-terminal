import { describe, expect, it } from "vitest";
import { ZipError, readSingleZipEntry, readZip } from "./zip.ts";
import { makeZip } from "./zipFixture.ts";

describe("zip", () => {
  it("inflates a deflated entry", () => {
    const content = "open_time,open\n1,2\n".repeat(500);
    const entry = readSingleZipEntry(makeZip([{ name: "BTCUSDT-1m-2025-03.csv", content }]));
    expect(entry.name).toBe("BTCUSDT-1m-2025-03.csv");
    expect(entry.data.toString("utf8")).toBe(content);
    expect(entry.uncompressedSize).toBe(Buffer.byteLength(content));
    expect(entry.compressedSize).toBeLessThan(entry.uncompressedSize);
  });

  it("reads a stored (uncompressed) entry", () => {
    const entry = readSingleZipEntry(makeZip([{ name: "a.csv", content: "hello", store: true }]));
    expect(entry.data.toString("utf8")).toBe("hello");
  });

  it("reads every entry of a multi-file archive", () => {
    const entries = readZip(makeZip([{ name: "a.csv", content: "a" }, { name: "b.csv", content: "bb" }]));
    expect(entries.map((e) => e.name)).toEqual(["a.csv", "b.csv"]);
    expect(entries.map((e) => e.data.toString("utf8"))).toEqual(["a", "bb"]);
  });

  it("refuses an archive that is not exactly one file", () => {
    expect(() => readSingleZipEntry(makeZip([{ name: "a.csv", content: "a" }, { name: "b.csv", content: "b" }]))).toThrow(ZipError);
    expect(() => readSingleZipEntry(makeZip([]))).toThrow(ZipError);
  });

  it("rejects a buffer without a central directory", () => {
    expect(() => readZip(Buffer.from("not a zip at all, not even close to it"))).toThrow(ZipError);
    expect(() => readZip(Buffer.alloc(4))).toThrow(ZipError);
  });

  it("rejects a corrupted archive instead of returning short data", () => {
    const zip = makeZip([{ name: "a.csv", content: "x".repeat(1000) }]);
    const broken = Buffer.concat([zip.subarray(0, 20), zip.subarray(21)]);
    expect(() => readZip(broken)).toThrow(ZipError);
  });
});
