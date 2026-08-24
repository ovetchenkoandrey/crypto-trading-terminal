import { describe, it, expect } from "vitest";
import { CursorBarHistory, EMPTY_HISTORY } from "./history";
import type { Candle } from "../types";

const bars: Candle[] = Array.from({ length: 5 }, (_, i) => ({
  time:   1000 + i * 60,
  open:   100 + i,
  high:   110 + i,
  low:     90 + i,
  close:  105 + i,
  volume:  10 + i,
}));

function at(index: number): CursorBarHistory {
  return new CursorBarHistory(bars, () => index);
}

describe("CursorBarHistory", () => {
  describe("look-ahead protection", () => {
    it("exposes only bars up to the cursor", () => {
      const h = at(2);

      expect(h.length).toBe(3);
      expect(h.at(2)).toBe(bars[2]);
      expect(h.at(3)).toBeUndefined();
      expect(h.at(4)).toBeUndefined();
    });

    it("never returns a future bar through last()", () => {
      const h = at(1);

      expect(h.last(10)).toEqual([bars[0], bars[1]]);
    });

    it("is empty before the first bar", () => {
      const h = at(-1);

      expect(h.length).toBe(0);
      expect(h.current()).toBeUndefined();
      expect(h.last(3)).toEqual([]);
      expect(h.closes(3)).toEqual([]);
    });

    it("does not run past the end of the series", () => {
      const h = at(99);

      expect(h.length).toBe(5);
      expect(h.at(5)).toBeUndefined();
    });

    it("grows as the cursor advances", () => {
      let index = 0;
      const h = new CursorBarHistory(bars, () => index);

      expect(h.length).toBe(1);
      index = 3;
      expect(h.length).toBe(4);
      expect(h.current()).toBe(bars[3]);
    });
  });

  describe("access", () => {
    it("current() returns the bar at the cursor", () => {
      expect(at(2).current()).toBe(bars[2]);
    });

    it("last() returns oldest first", () => {
      expect(at(4).last(3)).toEqual([bars[2], bars[3], bars[4]]);
    });

    it("last() clamps to available history", () => {
      expect(at(1).last(100)).toHaveLength(2);
    });

    it("rejects non-positive and non-finite windows", () => {
      const h = at(4);

      expect(h.last(0)).toEqual([]);
      expect(h.last(-3)).toEqual([]);
      expect(h.last(NaN)).toEqual([]);
    });

    it("rejects non-integer and negative indices", () => {
      const h = at(4);

      expect(h.at(-1)).toBeUndefined();
      expect(h.at(1.5)).toBeUndefined();
    });

    it("extracts field series in bar order", () => {
      const h = at(4);

      expect(h.closes(3)).toEqual([107, 108, 109]);
      expect(h.highs(2)).toEqual([113, 114]);
      expect(h.lows(2)).toEqual([93, 94]);
      expect(h.volumes(2)).toEqual([13, 14]);
    });
  });
});

describe("EMPTY_HISTORY", () => {
  it("reports nothing available", () => {
    expect(EMPTY_HISTORY.length).toBe(0);
    expect(EMPTY_HISTORY.current()).toBeUndefined();
    expect(EMPTY_HISTORY.at(0)).toBeUndefined();
    expect(EMPTY_HISTORY.last(5)).toEqual([]);
    expect(EMPTY_HISTORY.closes(5)).toEqual([]);
  });
});
